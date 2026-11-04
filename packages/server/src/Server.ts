/**
 * The Upkeep server: the HTTP API workers and the CLI talk to, the dashboard,
 * the scheduler that queues jobs on their cron, the sweep that fails runs
 * whose worker went quiet, the one that unparks jobs once their triage issue
 * is resolved, and the one that prunes old runs.
 */
import { BunHttpServer } from "@effect/platform-bun";
import { Api, Catalogue, Domain } from "@upkeep/api";
import { bundleDashboard } from "@upkeep/dashboard/bundle" with { type: "macro" };
import {
  Clock,
  Config,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schedule,
} from "effect";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Store, type NewRun } from "./Store";
import { Tokens } from "./Tokens";
import { Triage } from "./Triage";
import { version } from "./Version";

/** How long a running run can go without a heartbeat before it's lost. */
export const lostAfter = Duration.minutes(10);

const defaultRuns = 50;

const defaultLogLines = Api.maxLogLines;

/** A requested count, between 1 and `max`. */
const bounded = (limit: number | undefined, fallback: number, max: number) =>
  Math.min(Math.max(limit ?? fallback, 1), max);

const AdminAuthorizationLayer = Layer.effect(
  Api.AdminAuthorization,
  Effect.gen(function* () {
    const tokens = yield* Tokens;

    return Api.AdminAuthorization.of({
      bearer: Effect.fn(function* (httpEffect, { credential }) {
        const admin = yield* tokens
          .authenticate("admin", credential)
          .pipe(Effect.orDie);

        if (Option.isNone(admin)) {
          return yield* new Api.Unauthorized({
            message: "Missing or unknown admin token",
          });
        }

        return yield* Effect.provideService(httpEffect, Api.CurrentAdmin, {
          name: admin.value,
        });
      }),
    });
  }),
);

const WorkerAuthorizationLayer = Layer.effect(
  Api.WorkerAuthorization,
  Effect.gen(function* () {
    const tokens = yield* Tokens;

    return Api.WorkerAuthorization.of({
      bearer: Effect.fn(function* (httpEffect, { credential }) {
        const worker = yield* tokens
          .authenticate("worker", credential)
          .pipe(Effect.orDie);

        if (Option.isNone(worker)) {
          return yield* new Api.Unauthorized({
            message: "Missing or unknown worker token",
          });
        }

        return yield* Effect.provideService(httpEffect, Api.CurrentWorker, {
          name: worker.value,
        });
      }),
    });
  }),
);

const findJob = (id: string) =>
  Option.fromNullishOr(Catalogue.jobs.find((job) => job.id === id));

/** How many heals a job can have a day for one target. */
const healsPerDay = Config.Int("UPKEEP_HEALS_PER_DAY").pipe(
  Config.withDefault(3),
);

/** Queue a run and log it, so the server's log shows what it started. */
const queue = Effect.fn("queue")(function* (run: NewRun) {
  const store = yield* Store;

  // A parked job is only run by hand until it's unparked.
  if (run.trigger !== "manual") {
    const parked = yield* store.parked();

    if (parked.has(run.job) || (run.heal && parked.has(run.heal.job))) {
      yield* Effect.logInfo(`Skipped ${run.job}: parked`);

      return Option.none<Domain.Run>();
    }
  }

  const queued = yield* store.queueRun(run);

  yield* Effect.logInfo(`Queued ${queued.job}`).pipe(
    Effect.annotateLogs({
      run: queued.id,
      trigger: queued.trigger,
      release:
        queued.release === null
          ? ""
          : `${queued.release.repo}@${queued.release.tag}`,
      heals: queued.heal?.of ?? "",
    }),
  );

  return Option.some(queued);
});

/**
 * Queue a heal for each target of a failed or lost run: each failed consumer
 * of a bump, or Upkeep itself. A failed heal never queues another. A target
 * past its heals for the day gets no more: a consumer is skipped, and a job
 * failing in itself is parked.
 */
const heal = Effect.fn("heal")(function* (
  run: Domain.Run,
  consumers: ReadonlyArray<string>,
) {
  if (run.job === Catalogue.heal.id || run.state !== "failed") return;

  const store = yield* Store;
  const limit = yield* healsPerDay;
  const now = yield* Clock.currentTimeMillis;

  const since = now - Duration.toMillis("1 day");

  const targets: ReadonlyArray<Domain.Target> =
    consumers.length === 0
      ? [{ kind: "upkeep" }]
      : consumers.map((repo) => ({ kind: "consumer", repo }));

  const triage = yield* Triage;

  const issues = yield* Effect.forEach(targets, (target) =>
    triage.report(run, target),
  );

  for (const [index, target] of targets.entries()) {
    const used = yield* store.healsSince(run.job, target, since);

    if (used >= limit) {
      // One consumer failing all day mustn't stop the job for the others, so
      // only a job failing in itself is parked.
      if (target.kind === "consumer") {
        yield* Effect.logWarning(
          `Skipped a heal of ${run.job} for ${target.repo}: past ${limit} heals today`,
        ).pipe(Effect.annotateLogs({ run: run.id }));

        continue;
      }

      const reason = `${run.job} failed again after ${used} heals today, past the limit of ${limit}`;

      yield* store.park(
        run.job,
        reason,
        Option.getOrNull(issues[index] ?? Option.none()),
      );
      yield* Effect.logWarning(`Parked ${run.job}`).pipe(
        Effect.annotateLogs({ run: run.id, reason }),
      );

      continue;
    }

    yield* queue({
      job: Catalogue.heal.id,
      trigger: "heal",
      release: run.release,
      heal: {
        of: run.id,
        job: run.job,
        target,
        issue: Option.getOrNull(issues[index] ?? Option.none()),
      },
    });
  }
});

/**
 * Unpark each job whose triage issue has been resolved, once a minute, so
 * resolving the failure in triage lets the job run again.
 */
export const unparkResolved = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Store;
    const triage = yield* Triage;

    yield* Effect.gen(function* () {
      const parked = yield* store.parked();

      for (const [job, { issue }] of parked) {
        if (issue === null || !(yield* triage.resolved(issue))) continue;

        if (yield* store.unpark(job)) {
          yield* Effect.logInfo(`Unparked ${job}: its triage issue resolved`);
        }
      }
    }).pipe(
      Effect.catchCause(Effect.logError),
      Effect.repeat(Schedule.spaced(Duration.minutes(1))),
      Effect.forkScoped,
    );
  }),
);

/** A heal run's record and the run it's healing. Other runs aren't found. */
const healedRun = Effect.fnUntraced(function* (id: string) {
  const store = yield* Store;
  const healing = yield* store.run(id);

  if (healing.heal === null) return yield* new Api.RunNotFound({ id });

  return { heal: healing.heal, run: yield* store.run(healing.heal.of) };
});

const JobsHandlers = HttpApiBuilder.group(
  Api.Api,
  "jobs",
  Effect.fn(function* (handlers) {
    const store = yield* Store;

    return handlers.handleAll({
      list: Effect.fn(function* () {
        const latest = yield* store.latestRuns().pipe(Effect.orDie);
        const parked = yield* store.parked().pipe(Effect.orDie);

        return Catalogue.jobs.map((job): Domain.JobStatus => ({
          id: job.id,
          name: job.name,
          description: job.description,
          schedule: job.schedule,
          onRelease: job.onRelease,
          lane: job.lane,
          tracked: job.tracked,
          lastRun: latest.get(job.id) ?? null,
          parked: parked.get(job.id) ?? null,
        }));
      }),
      run: Effect.fn(function* ({ params, payload }) {
        if (Option.isNone(findJob(params.id))) {
          return yield* new Api.JobNotFound({ id: params.id });
        }

        const queued = yield* queue({
          job: params.id,
          trigger: "manual",
          release: payload.release ?? null,
        }).pipe(Effect.provideService(Store, store), Effect.orDie);

        return yield* Option.match(queued, {
          onNone: () => Effect.die(new Error("A manual run wasn't queued")),
          onSome: Effect.succeed,
        });
      }),
      unpark: Effect.fn(function* ({ params }) {
        if (Option.isNone(findJob(params.id))) {
          return yield* new Api.JobNotFound({ id: params.id });
        }

        const admin = yield* Api.CurrentAdmin;

        if (yield* store.unpark(params.id).pipe(Effect.orDie)) {
          yield* Effect.logInfo(`Unparked ${params.id}`).pipe(
            Effect.annotateLogs({ admin: admin.name }),
          );
        }
      }),
    });
  }),
);

const RunsHandlers = HttpApiBuilder.group(
  Api.Api,
  "runs",
  Effect.fn(function* (handlers) {
    const store = yield* Store;

    return handlers.handleAll({
      list: ({ query }) =>
        store
          .runs({
            job: query.job,
            state: query.state,
            limit: bounded(query.limit, defaultRuns, Api.maxRuns),
          })
          .pipe(Effect.orDie),
      get: ({ params }) =>
        store.run(params.id).pipe(Effect.catchTag("StoreError", Effect.die)),
      log: ({ params, query }) =>
        store
          .log(params.id, query.after ?? 0, defaultLogLines)
          .pipe(Effect.catchTag("StoreError", Effect.die)),
      cancel: Effect.fn(function* ({ params }) {
        const admin = yield* Api.CurrentAdmin;

        const cancelled = yield* store
          .cancel(params.id, admin.name)
          .pipe(Effect.catchTag("StoreError", Effect.die));

        yield* Effect.logInfo(
          `${cancelled.dropped ? "Dropped" : "Cancelled"} ${cancelled.run.job}`,
        ).pipe(Effect.annotateLogs({ run: params.id, admin: admin.name }));

        return cancelled;
      }),
    });
  }),
);

const WorkHandlers = HttpApiBuilder.group(
  Api.Api,
  "work",
  Effect.fn(function* (handlers) {
    const store = yield* Store;
    const triage = yield* Triage;

    return handlers.handleAll({
      claim: Effect.fn(function* ({ payload }) {
        const worker = yield* Api.CurrentWorker;

        const run = yield* store
          .claim(payload.jobs, worker.name)
          .pipe(Effect.orDie);

        if (Option.isSome(run)) {
          yield* Effect.logInfo(`${worker.name} took ${run.value.job}`).pipe(
            Effect.annotateLogs({ run: run.value.id }),
          );
        }

        return { run: Option.getOrNull(run) };
      }),
      heartbeat: Effect.fn(function* ({ params }) {
        const worker = yield* Api.CurrentWorker;

        yield* store
          .heartbeat(params.id, worker.name)
          .pipe(Effect.catchTag("StoreError", Effect.die));
      }),
      log: Effect.fn(function* ({ params, payload }) {
        const worker = yield* Api.CurrentWorker;

        yield* store
          .appendLog(params.id, worker.name, payload.lines)
          .pipe(Effect.catchTag("StoreError", Effect.die));
      }),
      finish: Effect.fn(function* ({ params, payload }) {
        const worker = yield* Api.CurrentWorker;

        const ended = yield* store
          .finish(
            params.id,
            worker.name,
            payload.outcome,
            payload.error ?? null,
          )
          .pipe(Effect.catchTag("StoreError", Effect.die));

        yield* Effect.logInfo(`Run ${payload.outcome}`).pipe(
          Effect.annotateLogs({ run: params.id, worker: worker.name }),
        );

        yield* heal(ended, payload.consumers ?? []).pipe(
          Effect.provideService(Store, store),
          Effect.provideService(Triage, triage),
          Effect.catchCause(Effect.logError),
        );
      }),
      heal: Effect.fn(function* ({ params, payload }) {
        const worker = yield* Api.CurrentWorker;

        yield* store
          .updateHeal(params.id, worker.name, payload)
          .pipe(Effect.catchTag("StoreError", Effect.die));

        // A pushed fix settles the failure in triage, with a note on how.
        if (payload.commit === undefined) return;

        const updated = yield* store
          .run(params.id)
          .pipe(Effect.catchTag("StoreError", Effect.die));

        const record = updated.heal;

        if (record === null || record.issue === null) return;

        yield* triage.resolve(
          record.issue,
          [
            `Fixed by Upkeep's heal run ${updated.id} in ${payload.commit}.`,
            "",
            `What broke: ${record.reason ?? record.job}`,
            ...record.actions.map((action) => `- ${action}`),
          ].join("\n"),
        );
      }),
      healing: Effect.fn(function* ({ params }) {
        const worker = yield* Api.CurrentWorker;

        return yield* Effect.gen(function* () {
          yield* store.claimed(params.id, worker.name);

          const { heal, run } = yield* healedRun(params.id);

          return {
            heal,
            run,
            log: yield* store.logTail(run.id, Api.healLogLines),
            precedents:
              heal.issue === null ? [] : yield* triage.precedents(heal.issue),
          };
        }).pipe(
          Effect.provideService(Store, store),
          Effect.catchTag("StoreError", Effect.die),
        );
      }),
      heals: ({ query }) => store.heals(query.since).pipe(Effect.orDie),
      parked: () =>
        store.parked().pipe(
          Effect.map((parked) =>
            [...parked].map(([job, { reason, at, issue }]) => ({
              job,
              reason,
              at,
              issue,
            })),
          ),
          Effect.orDie,
        ),
      retry: Effect.fn(function* ({ params }) {
        const worker = yield* Api.CurrentWorker;

        return yield* Effect.gen(function* () {
          yield* store.claimed(params.id, worker.name);

          const { run } = yield* healedRun(params.id);

          const queued = yield* queue({
            job: run.job,
            trigger: "heal",
            release: run.release,
          });

          return { run: Option.getOrNull(queued) };
        }).pipe(
          Effect.provideService(Store, store),
          Effect.catchTag("StoreError", Effect.die),
        );
      }),
      park: Effect.fn(function* ({ params, payload }) {
        if (Option.isNone(findJob(params.job))) {
          return yield* new Api.JobNotFound({ id: params.job });
        }

        const worker = yield* Api.CurrentWorker;

        yield* store
          .park(params.job, payload.reason, payload.issue ?? null)
          .pipe(Effect.orDie);

        yield* Effect.logWarning(`Parked ${params.job}`).pipe(
          Effect.annotateLogs({ worker: worker.name, reason: payload.reason }),
        );
      }),
      repos: ({ query }) =>
        store.repos().pipe(
          Effect.map((all) =>
            all
              .filter((tracked) => tracked.jobs.includes(query.job))
              .map((tracked) => tracked.repo),
          ),
          Effect.orDie,
        ),
      releases: Effect.fn(function* ({ payload }) {
        // Only the releases of repositories tracked for it count, whatever a
        // worker sends.
        const tracked = new Set(
          (yield* store.repos().pipe(Effect.orDie))
            .filter((repo) => repo.jobs.includes(Catalogue.releases.id))
            .map((repo) => repo.repo.toLowerCase()),
        );

        const changed = yield* store
          .recordReleases(
            payload.releases.filter((release) =>
              tracked.has(release.repo.toLowerCase()),
            ),
          )
          .pipe(Effect.orDie);

        const onRelease = Catalogue.jobs.filter((job) => job.onRelease);

        const queued = yield* Effect.forEach(
          changed.flatMap((release) =>
            onRelease.map((job) => ({
              job: job.id,
              trigger: "release" as const,
              release,
            })),
          ),
          queue,
        ).pipe(Effect.provideService(Store, store), Effect.orDie);

        return { queued: queued.flatMap(Option.toArray) };
      }),
    });
  }),
);

const ReposHandlers = HttpApiBuilder.group(
  Api.Api,
  "repos",
  Effect.fn(function* (handlers) {
    const store = yield* Store;

    return handlers.handleAll({
      list: () => store.repos().pipe(Effect.orDie),
      track: Effect.fn(function* ({ params, payload }) {
        const admin = yield* Api.CurrentAdmin;
        const repo = `${params.owner}/${params.name}`;
        const tracked = Catalogue.jobs.filter((job) => job.tracked);

        const unknown = (payload.jobs ?? []).filter(
          (id) => !tracked.some((job) => job.id === id),
        );

        if (unknown.length > 0) {
          return yield* new Api.UntrackedJobs({ jobs: unknown });
        }

        const jobs = [
          ...new Set(payload.jobs ?? tracked.map((job) => job.id)),
        ].toSorted();

        const saved = yield* store.track(repo, jobs).pipe(Effect.orDie);

        yield* Effect.logInfo(`Tracked ${saved.repo}`).pipe(
          Effect.annotateLogs({ admin: admin.name, jobs: jobs.join(",") }),
        );

        return saved;
      }),
      untrack: Effect.fn(function* ({ params }) {
        const admin = yield* Api.CurrentAdmin;
        const repo = `${params.owner}/${params.name}`;

        if (!(yield* store.untrack(repo).pipe(Effect.orDie))) {
          return yield* new Api.RepoNotTracked({ repo });
        }

        yield* Effect.logInfo(`Stopped tracking ${repo}`).pipe(
          Effect.annotateLogs({ admin: admin.name }),
        );
      }),
    });
  }),
);

const TokensHandlers = HttpApiBuilder.group(
  Api.Api,
  "tokens",
  Effect.fn(function* (handlers) {
    const tokens = yield* Tokens;

    return handlers.handleAll({
      list: ({ params }) => tokens.list(params.scope).pipe(Effect.orDie),
      add: ({ params, payload }) =>
        tokens.issue(params.scope, payload.name).pipe(
          Effect.map((token) => ({ token: Redacted.value(token) })),
          Effect.catchTag("StoreError", Effect.die),
        ),
      remove: ({ params }) =>
        tokens
          .revoke(params.scope, params.name)
          .pipe(Effect.catchTag("StoreError", Effect.die)),
    });
  }),
);

const SystemHandlers = HttpApiBuilder.group(Api.Api, "system", (handlers) =>
  Effect.succeed(
    handlers
      .handle("health", () => HttpMiddleware.withLoggerDisabled(Effect.void))
      .handle("version", () => Effect.succeed({ version })),
  ),
);

/** The API's routes with `adminAuthorization`, needing a `Store` and `Tokens`. */
const apiRoutes = (
  adminAuthorization: Layer.Layer<Api.AdminAuthorization, never, Tokens>,
) =>
  HttpApiBuilder.layer(Api.Api, {
    openapiPath: "/api/openapi.json",
  }).pipe(
    Layer.provide([
      JobsHandlers,
      RunsHandlers,
      WorkHandlers,
      ReposHandlers,
      TokensHandlers,
      SystemHandlers,
    ]),
    Layer.provide([adminAuthorization, WorkerAuthorizationLayer]),
  );

/** The API's routes, needing a `Store` and `Tokens`. */
export const routes = apiRoutes(AdminAuthorizationLayer);

/**
 * Admin access for Home Assistant ingress, where Home Assistant has already
 * signed the user in. Only safe behind `ingressGuard`.
 */
const IngressAdminAuthorizationLayer = Layer.succeed(
  Api.AdminAuthorization,
  Api.AdminAuthorization.of({
    bearer: (httpEffect) =>
      Effect.provideService(httpEffect, Api.CurrentAdmin, {
        name: "home-assistant",
      }),
  }),
);

/** Answers only the Supervisor on the ingress port, refusing everyone else. */
const ingressGuard =
  (supervisor: string) =>
  <E, R>(
    httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Option.exists(
        request.remoteAddress,
        (remote) => remote === supervisor || remote === `::ffff:${supervisor}`,
      )
        ? httpEffect
        : Effect.succeed(HttpServerResponse.empty({ status: 403 })),
    );

const contentTypes = new Map([
  ["html", "text/html; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["svg", "image/svg+xml"],
]);

const { "index.html": indexHtml = "", ...assets } = bundleDashboard();

/** Assets at least this big are also kept gzipped, for browsers that take it. */
const compressFrom = 1024;

const assetHeaders = {
  "cache-control": "public, max-age=31536000, immutable",
  vary: "accept-encoding",
};

/**
 * The dashboard's assets, built into the binary. Their names carry a content
 * hash, so they never change. The bigger ones are compressed once here, so
 * the page's script isn't sent whole on every load.
 */
const dashboardFiles = new Map(
  Object.entries(assets).map(([name, body]) => {
    const contentType = contentTypes.get(name.split(".").pop() ?? "");

    const plain = HttpServerResponse.text(body, {
      contentType,
      headers: assetHeaders,
    });

    return [
      name,
      {
        plain,
        gzipped:
          body.length < compressFrom
            ? plain
            : HttpServerResponse.uint8Array(
                Bun.gzipSync(new TextEncoder().encode(body)),
                {
                  contentType,
                  headers: { ...assetHeaders, "content-encoding": "gzip" },
                },
              ),
      },
    ];
  }),
);

const acceptsGzip = (request: HttpServerRequest.HttpServerRequest) =>
  /(?:^|,)\s*gzip\s*(?:;|,|$)/.test(request.headers["accept-encoding"] ?? "");

const notFound = HttpServerResponse.empty({ status: 404 });

/** The page, with its base set to `base` so links and assets resolve under it. */
const page = (base: string) =>
  HttpServerResponse.text(
    indexHtml.replace('<base href="/"', `<base href="${base}"`),
    {
      contentType: contentTypes.get("html"),
      headers: { "cache-control": "no-cache" },
    },
  );

const rootPage = page("/");

/** Home Assistant's ingress prefix, such as `/api/hassio_ingress/<token>`. */
const ingressPath = /^\/api\/hassio_ingress\/[\w-]+$/;

/**
 * The dashboard. Asset files are served as they are, and every other path
 * outside the API gets the page, which routes in the browser. Under ingress
 * the page's base is the path Home Assistant serves it from.
 */
const dashboard = (options: { readonly ingress: boolean }) =>
  HttpRouter.add("GET", "/*", (request) => {
    const path = new URL(request.url, "http://upkeep").pathname.slice(1);
    const file = dashboardFiles.get(path);

    if (file !== undefined) {
      return Effect.succeed(acceptsGzip(request) ? file.gzipped : file.plain);
    }

    if (
      path === "api" ||
      path.startsWith("api/") ||
      (path.includes(".") && path !== "index.html")
    ) {
      return Effect.succeed(notFound);
    }

    const prefix = request.headers["x-ingress-path"];

    return Effect.succeed(
      options.ingress && prefix !== undefined && ingressPath.test(prefix)
        ? page(`${prefix}/`)
        : rootPage,
    );
  });

/**
 * Queue each scheduled job on its cron. A failure is logged and the schedule
 * carries on; a run that's still waiting isn't queued twice.
 */
export const scheduler = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Store;

    for (const job of Catalogue.jobs) {
      if (job.schedule === null) continue;

      yield* queue({ job: job.id, trigger: "schedule", release: null }).pipe(
        Effect.provideService(Store, store),
        Effect.catchCause(Effect.logError),
        Effect.schedule(Schedule.cron(job.schedule)),
        Effect.forkScoped,
      );
    }
  }),
);

/** Fail runs whose worker stopped sending heartbeats, once a minute. */
export const lostRuns = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Store;
    const triage = yield* Triage;

    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const lost = yield* store.failLost(now - Duration.toMillis(lostAfter));

      for (const run of lost) {
        yield* Effect.logWarning(`Lost ${run.job} on ${run.worker}`).pipe(
          Effect.annotateLogs({ run: run.id }),
        );

        yield* heal(run, []).pipe(Effect.catchCause(Effect.logError));
      }
    }).pipe(
      Effect.provideService(Store, store),
      Effect.provideService(Triage, triage),
      Effect.catchCause(Effect.logError),
      Effect.repeat(Schedule.spaced(Duration.minutes(1))),
      Effect.forkScoped,
    );
  }),
);

/** How long finished runs are kept, and how many of each job's survive that. */
const retention = Config.all({
  days: Config.Int("UPKEEP_KEEP_DAYS").pipe(Config.withDefault(30)),
  runs: Config.Int("UPKEEP_KEEP_RUNS").pipe(Config.withDefault(20)),
});

/**
 * Delete finished runs and their logs past the retention window, once an
 * hour, keeping the latest runs of each job however old they are.
 */
export const pruneRuns = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Store;
    const keep = yield* retention;

    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      const pruned = yield* store.prune(
        now - Duration.toMillis(Duration.days(keep.days)),
        keep.runs,
      );

      if (pruned > 0) yield* Effect.logInfo(`Pruned ${pruned} old runs`);
    }).pipe(
      Effect.catchCause(Effect.logError),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.forkScoped,
    );
  }),
);

export interface ServeOptions {
  readonly hostname: string;
  readonly port: number;
  /**
   * A second port for Home Assistant ingress, which only answers `ingressFrom`
   * and treats every request as an admin's, since Home Assistant has already
   * signed the user in.
   */
  readonly ingressPort: Option.Option<number>;
  /** The address ingress requests come from: the Supervisor's. */
  readonly ingressFrom: string;
}

/**
 * Serve the API and the dashboard over plain HTTP, with the scheduler and the
 * lost-run, unpark and prune sweeps. For HTTPS, put it behind a reverse proxy,
 * which handles TLS.
 */
export const layer = (options: ServeOptions) =>
  Layer.mergeAll(
    HttpRouter.serve(Layer.merge(routes, dashboard({ ingress: false }))).pipe(
      Layer.provide(
        BunHttpServer.layer({ hostname: options.hostname, port: options.port }),
      ),
    ),
    Option.match(options.ingressPort, {
      onNone: () => Layer.empty,
      onSome: (port) =>
        HttpRouter.serve(
          Layer.merge(
            apiRoutes(IngressAdminAuthorizationLayer),
            dashboard({ ingress: true }),
          ),
          { middleware: ingressGuard(options.ingressFrom) },
        ).pipe(
          Layer.provide(
            BunHttpServer.layer({ hostname: options.hostname, port }),
          ),
        ),
    }),
    scheduler,
    lostRuns,
    unparkResolved,
    pruneRuns,
  ).pipe(
    Layer.provide([Tokens.layer, Triage.layer]),
    Layer.provideMerge(Store.layer),
  );
