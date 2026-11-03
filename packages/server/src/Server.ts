/**
 * The Upkeep server: the HTTP API workers and the CLI talk to, the scheduler
 * that queues jobs on their cron, the sweep that fails runs whose worker went
 * quiet, the one that unparks jobs once their triage issue is resolved, and
 * the one that prunes old runs.
 */
import { BunHttpServer } from "@effect/platform-bun";
import { Api, Catalogue, Domain } from "@upkeep/api";
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
import { HttpMiddleware, HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Store, type NewRun } from "./Store";
import { Tokens } from "./Tokens";
import { Triage } from "./Triage";

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

/** How many heals one job can have a day before it's parked. */
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
 * of a bump, or Upkeep itself. A failed heal never queues another, and a job
 * past its heals for the day is parked instead.
 */
const heal = Effect.fn("heal")(function* (
  run: Domain.Run,
  consumers: ReadonlyArray<string>,
) {
  if (run.job === Catalogue.heal.id || run.state !== "failed") return;

  const store = yield* Store;
  const limit = yield* healsPerDay;
  const now = yield* Clock.currentTimeMillis;

  const used = yield* store.healsSince(
    run.job,
    now - Duration.toMillis("1 day"),
  );

  const targets: ReadonlyArray<Domain.Target> =
    consumers.length === 0
      ? [{ kind: "upkeep" }]
      : consumers.map((repo) => ({ kind: "consumer", repo }));

  const triage = yield* Triage;

  const issues = yield* Effect.forEach(targets, (target) =>
    triage.report(run, target),
  );

  if (used + targets.length > limit) {
    const reason = `${run.job} failed again after ${used} heals today, past the limit of ${limit}`;

    yield* store.park(
      run.job,
      reason,
      Option.getOrNull(Option.firstSomeOf(issues)),
    );
    yield* Effect.logWarning(`Parked ${run.job}`).pipe(
      Effect.annotateLogs({ run: run.id, reason }),
    );

    return;
  }

  for (const [index, target] of targets.entries()) {
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
      releases: Effect.fn(function* ({ payload }) {
        const changed = yield* store
          .recordReleases(payload.releases)
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
    handlers.handle("health", () =>
      HttpMiddleware.withLoggerDisabled(Effect.void),
    ),
  ),
);

/** The API's routes, needing a `Store` and `Tokens`. */
export const routes = HttpApiBuilder.layer(Api.Api, {
  openapiPath: "/api/openapi.json",
}).pipe(
  Layer.provide([
    JobsHandlers,
    RunsHandlers,
    WorkHandlers,
    TokensHandlers,
    SystemHandlers,
  ]),
  Layer.provide([AdminAuthorizationLayer, WorkerAuthorizationLayer]),
);

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
}

/**
 * Serve the API over plain HTTP, with the scheduler and the lost-run, unpark
 * and prune sweeps. For HTTPS, put it behind a reverse proxy, which handles
 * TLS.
 */
export const layer = (options: ServeOptions) =>
  Layer.mergeAll(
    HttpRouter.serve(routes).pipe(Layer.provide(BunHttpServer.layer(options))),
    scheduler,
    lostRuns,
    unparkResolved,
    pruneRuns,
  ).pipe(
    Layer.provide([Tokens.layer, Triage.layer]),
    Layer.provideMerge(Store.layer),
  );
