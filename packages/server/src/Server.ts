/**
 * The Upkeep server: the HTTP API workers and the CLI talk to, the scheduler
 * that queues jobs on their cron, and the sweep that fails runs whose worker
 * went quiet.
 */
import { BunHttpServer } from "@effect/platform-bun";
import { Api, Catalogue, Domain } from "@upkeep/api";
import {
  Clock,
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

/** Queue a run and log it, so the server's log shows what it started. */
const queue = Effect.fn("queue")(function* (run: NewRun) {
  const queued = yield* (yield* Store).queueRun(run);

  yield* Effect.logInfo(`Queued ${queued.job}`).pipe(
    Effect.annotateLogs({
      run: queued.id,
      trigger: queued.trigger,
      release:
        queued.release === null
          ? ""
          : `${queued.release.repo}@${queued.release.tag}`,
    }),
  );

  return queued;
});

const JobsHandlers = HttpApiBuilder.group(
  Api.Api,
  "jobs",
  Effect.fn(function* (handlers) {
    const store = yield* Store;

    return handlers.handleAll({
      list: Effect.fn(function* () {
        const latest = yield* store.latestRuns().pipe(Effect.orDie);

        return Catalogue.jobs.map((job): Domain.JobStatus => ({
          id: job.id,
          name: job.name,
          description: job.description,
          schedule: job.schedule,
          onRelease: job.onRelease,
          lastRun: latest.get(job.id) ?? null,
        }));
      }),
      run: Effect.fn(function* ({ params, payload }) {
        if (Option.isNone(findJob(params.id))) {
          return yield* new Api.JobNotFound({ id: params.id });
        }

        return yield* queue({
          job: params.id,
          trigger: "manual",
          release: payload.release ?? null,
        }).pipe(Effect.provideService(Store, store), Effect.orDie);
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
    });
  }),
);

const WorkHandlers = HttpApiBuilder.group(
  Api.Api,
  "work",
  Effect.fn(function* (handlers) {
    const store = yield* Store;

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

        yield* store
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

        return { queued };
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

    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const lost = yield* store.failLost(now - Duration.toMillis(lostAfter));

      for (const run of lost) {
        yield* Effect.logWarning(`Lost ${run.job} on ${run.worker}`).pipe(
          Effect.annotateLogs({ run: run.id }),
        );
      }
    }).pipe(
      Effect.catchCause(Effect.logError),
      Effect.repeat(Schedule.spaced(Duration.minutes(1))),
      Effect.forkScoped,
    );
  }),
);

export interface ServeOptions {
  readonly hostname: string;
  readonly port: number;
}

/**
 * Serve the API over plain HTTP, with the scheduler and lost-run sweep. For
 * HTTPS, put it behind a reverse proxy, which handles TLS.
 */
export const layer = (options: ServeOptions) =>
  Layer.mergeAll(
    HttpRouter.serve(routes).pipe(Layer.provide(BunHttpServer.layer(options))),
    scheduler,
    lostRuns,
  ).pipe(Layer.provide(Tokens.layer), Layer.provideMerge(Store.layer));
