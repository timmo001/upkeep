/**
 * The Upkeep server: the HTTP API workers and the CLI talk to, the dashboard,
 * the scheduler that queues jobs on their cron, the sweep that fails runs
 * whose worker went quiet, the one that unparks jobs once their triage issue
 * is resolved, the one that queues heals held back by the heal limit, the one
 * that prunes old runs, and the pull of GitHub's events from their queue.
 */
import { BunHttpServer } from "@effect/platform-bun";
import { Api, Catalogue, Domain, EventJobs } from "@upkeep/api";
import { bundleDashboard } from "@upkeep/dashboard/bundle" with { type: "macro" };
import {
  Clock,
  Config,
  Cron,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
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
import { Events } from "./Events";
import { Store, type NewRun } from "./Store";
import { Tokens } from "./Tokens";
import { Triage } from "./Triage";
import { version } from "./Version";

/** How long a running run can go without a heartbeat before it's lost. */
export const lostAfter = Duration.minutes(10);

/** The longest a worker is held waiting for work or a cancel. */
const longestWait = 120;

/**
 * Wait up to `seconds` for a change that `matches`, then run `next`, as many
 * times as it says to go on. Only the waiting is timed, so `next`, which may
 * take a run, is never cut off with its result lost.
 */
const held = Effect.fnUntraced(function* <A, E>(
  changes: PubSub.Subscription<Domain.StateChange>,
  seconds: number,
  matches: (change: Domain.StateChange) => boolean,
  next: Effect.Effect<Option.Option<A>, E>,
) {
  const deadline =
    (yield* Clock.currentTimeMillis) +
    Math.min(Math.max(seconds, 0), longestWait) * 1000;

  for (;;) {
    const left = deadline - (yield* Clock.currentTimeMillis);

    if (left <= 0) return Option.none<A>();

    const change = yield* PubSub.take(changes).pipe(
      Effect.repeat({ until: matches }),
      Effect.timeoutOption(Duration.millis(left)),
    );

    if (Option.isNone(change)) return Option.none<A>();

    const done = yield* Effect.uninterruptible(next);

    if (Option.isSome(done)) return done;
  }
});

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

/** How many heals a job can have for one target in any 24 hours. */
const healsPerDay = Config.Int("UPKEEP_HEALS_PER_DAY").pipe(
  Config.withDefault(3),
);

/**
 * The repository a run of a job is narrowed to, as the server tracks it: the
 * job has to work on repositories, and the repository has to be tracked for
 * it (or at all, for watch).
 */
const scopeTo = Effect.fn("scopeTo")(function* (
  store: Store["Service"],
  job: Domain.Job,
  repo: string,
) {
  if (!Catalogue.scopable(job)) {
    return yield* new Api.RepoNotScopable({
      id: job.id,
      repo,
      reason: "it doesn't work on repositories",
    });
  }

  const found = (yield* store.repos().pipe(Effect.orDie)).find(
    (tracked) => tracked.repo.toLowerCase() === repo.toLowerCase(),
  );

  const needs = Catalogue.trackingJob(job);

  if (found === undefined || (needs !== null && !found.jobs.includes(needs))) {
    return yield* new Api.RepoNotScopable({
      id: job.id,
      repo,
      reason:
        found === undefined
          ? "it isn't tracked"
          : `it isn't tracked for ${needs}`,
    });
  }

  return found.repo;
});

/** Queue a run and log it, so the server's log shows what it started. */
const queue = Effect.fn("queue")(function* (run: NewRun) {
  const store = yield* Store;

  // A parked or paused job is only run by hand until it's let go again.
  if (run.trigger !== "manual") {
    const parked = yield* store.parked();
    const paused = yield* store.paused();

    const held = (job: string) =>
      paused.has(job) ? "paused" : parked.has(job) ? "parked" : null;

    const why = held(run.job) ?? (run.heal ? held(run.heal.job) : null);

    if (why !== null) {
      // A release would otherwise be lost, so it waits for the job
      if (
        (run.trigger === "release" || run.trigger === "event") &&
        run.release !== null &&
        !run.heal
      ) {
        yield* store.hold(run.job, run.release);
        yield* Effect.logInfo(
          `Held ${run.job} for ${run.release.repo}@${run.release.tag}: ${why}`,
        );
      } else yield* Effect.logInfo(`Skipped ${run.job}: ${why}`);

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
      repo: queued.repo ?? "",
      heals: queued.heal?.of ?? "",
    }),
  );

  return Option.some(queued);
});

/**
 * Record the latest releases of the repositories tracked for the releases
 * job, and queue every job that runs on releases for each new one. A release
 * seen before, from the releases job or an event, queues nothing, so the two
 * never queue the same release twice. Returns the runs queued.
 */
const queueReleases = Effect.fn("queueReleases")(function* (
  releases: ReadonlyArray<Domain.Release>,
  trigger: Domain.Trigger,
) {
  const store = yield* Store;

  // Only the releases of repositories tracked for it count, whatever a worker
  // or event sends.
  const tracked = new Set(
    (yield* store.repos())
      .filter((repo) => repo.jobs.includes(Catalogue.releases.id))
      .map((repo) => repo.repo.toLowerCase()),
  );

  const changed = yield* store.recordReleases(
    releases.filter((release) => tracked.has(release.repo.toLowerCase())),
  );

  const onRelease = Catalogue.jobs.filter((job) => job.onRelease);

  const queued = yield* Effect.forEach(
    changed.flatMap((release) =>
      onRelease.map((job) => ({ job: job.id, trigger, release })),
    ),
    queue,
  );

  return queued.flatMap(Option.toArray);
});

/** The workers that asked for work in the last half hour, which machine jobs run on. */
const liveWorkers = Effect.fn("liveWorkers")(function* () {
  const store = yield* Store;

  const since =
    (yield* Clock.currentTimeMillis) - Duration.toMillis("30 minutes");

  return (yield* store.agents())
    .filter((worker) => worker.at >= since)
    .map((worker) => worker.worker);
});

/**
 * Queue a machine job on each live worker, returning the first run queued. A
 * job held by a pause or park is skipped as usual.
 */
const queueMachine = Effect.fn("queueMachine")(function* (
  job: Domain.JobId,
  trigger: Domain.Trigger,
) {
  const queued: Array<Domain.Run> = [];

  for (const worker of yield* liveWorkers()) {
    const run = yield* queue({
      job,
      trigger,
      release: null,
      command: { kind: "machine", worker },
    });

    if (Option.isSome(run)) queued.push(run.value);
  }

  return Option.fromNullishOr(queued[0]);
});

/**
 * Queue the heals of a failed or lost run: one for Upkeep itself, or for the
 * consumers of a bump that failed, one heal over all of them, so a single
 * agent session makes the same fix everywhere. A failed heal never queues
 * another. A target past its heals for the day gets no more for now: a
 * consumer's heal waits until its heals free up, and a job failing in itself
 * is parked.
 */
const heal = Effect.fn("heal")(function* (
  run: Domain.Run,
  consumers: ReadonlyArray<string>,
) {
  // A command or machine job that failed shows on its run, with nothing for
  // an agent to fix in a repository
  if (
    run.job === Catalogue.heal.id ||
    run.job === Catalogue.command.id ||
    run.command?.kind === "machine" ||
    run.state !== "failed"
  )
    return;

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

  const healing: Array<{
    readonly repo: string;
    readonly issue: string | null;
  }> = [];

  for (const [index, target] of targets.entries()) {
    const issue = Option.getOrNull(issues[index] ?? Option.none());
    const used = yield* store.healsSince(run.job, target, since);

    if (used >= limit) {
      // One consumer failing all day mustn't stop the job for the others, so
      // only a job failing in itself is parked.
      if (target.kind === "consumer") {
        yield* store.wait(run.job, target.repo, run.id, issue);
        yield* Effect.logWarning(
          `Held a heal of ${run.job} for ${target.repo} until its heals free up: past ${limit} heals in 24 hours`,
        ).pipe(Effect.annotateLogs({ run: run.id }));

        continue;
      }

      const reason = `${run.job} failed again after ${used} heals in 24 hours, past the limit of ${limit}`;

      yield* store.park(run.job, reason, issue);
      yield* Effect.logWarning(`Parked ${run.job}`).pipe(
        Effect.annotateLogs({ run: run.id, reason }),
      );

      continue;
    }

    if (target.kind === "upkeep") {
      yield* queue({
        job: Catalogue.heal.id,
        trigger: "heal",
        release: run.release,
        heal: { of: run.id, job: run.job, target, issue },
      });

      continue;
    }

    for (const repo of Domain.targetRepos(target)) {
      yield* store.stopWaiting(run.job, repo);
      healing.push({ repo, issue });
    }
  }

  const [first, ...more] = healing;

  if (first === undefined) return;

  yield* queue({
    job: Catalogue.heal.id,
    trigger: "heal",
    release: run.release,
    heal: {
      of: run.id,
      job: run.job,
      target:
        more.length === 0
          ? { kind: "consumer", repo: first.repo }
          : {
              kind: "consumers",
              repos: healing.map(({ repo }) => repo),
            },
      issue: healing.find(({ issue }) => issue !== null)?.issue ?? null,
    },
  });
});

/**
 * Queue the releases a job skipped while it was parked or paused, now it's
 * let go. One it's still held for is held again.
 */
const queueHeld = Effect.fn("queueHeld")(function* (job: string) {
  const store = yield* Store;
  const found = findJob(job);

  if (Option.isNone(found)) return;

  for (const release of yield* store.takeHeld(job)) {
    yield* queue({ job: found.value.id, trigger: "release", release });
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
          yield* queueHeld(job).pipe(Effect.provideService(Store, store));
        }
      }
    }).pipe(
      Effect.catchCause(Effect.logError),
      Effect.repeat(Schedule.spaced(Duration.minutes(1))),
      Effect.forkScoped,
    );
  }),
);

/**
 * Drop the waiting heals a finished run settles: a later run of the same job,
 * for the same released repository, that reached the consumer without it
 * failing. A run that failed in itself says nothing about its consumers.
 */
const settleWaiting = Effect.fn("settleWaiting")(function* (
  run: Domain.Run,
  consumers: ReadonlyArray<string>,
) {
  if (run.job === Catalogue.heal.id) return;

  if (
    run.state !== "succeeded" &&
    !(run.state === "failed" && consumers.length > 0)
  )
    return;

  const store = yield* Store;
  const failed = new Set(consumers.map((repo) => repo.toLowerCase()));

  for (const waiting of yield* store.waiting()) {
    if (
      waiting.job !== run.job ||
      waiting.run === run.id ||
      failed.has(waiting.repo.toLowerCase())
    )
      continue;

    const held = yield* store
      .run(waiting.run)
      .pipe(Effect.catchTag("RunNotFound", () => Effect.succeed(null)));

    if (held !== null && held.release?.repo !== run.release?.repo) continue;

    if (yield* store.stopWaiting(waiting.job, waiting.repo)) {
      yield* Effect.logInfo(
        `Dropped a waiting heal of ${waiting.job} for ${waiting.repo}: a later run reached it`,
      ).pipe(Effect.annotateLogs({ run: run.id }));
    }
  }
});

/**
 * Queue each waiting heal once its consumer's heals in the last 24 hours drop
 * under the limit, once a minute. One whose failed run has been pruned is
 * dropped.
 */
export const healWaiting = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Store;

    yield* Effect.gen(function* () {
      const limit = yield* healsPerDay;
      const now = yield* Clock.currentTimeMillis;
      const since = now - Duration.toMillis("1 day");

      for (const waiting of yield* store.waiting()) {
        const target: Domain.Target = { kind: "consumer", repo: waiting.repo };

        if ((yield* store.healsSince(waiting.job, target, since)) >= limit)
          continue;

        const held = yield* store
          .run(waiting.run)
          .pipe(Effect.catchTag("RunNotFound", () => Effect.succeed(null)));

        if (held === null) {
          yield* store.stopWaiting(waiting.job, waiting.repo);
          yield* Effect.logInfo(
            `Dropped a waiting heal of ${waiting.job} for ${waiting.repo}: its run is gone`,
          );

          continue;
        }

        const queued = yield* queue({
          job: Catalogue.heal.id,
          trigger: "heal",
          release: held.release,
          heal: { of: held.id, job: waiting.job, target, issue: waiting.issue },
        });

        // A paused or parked heal stays waiting until it's let go.
        if (Option.isSome(queued))
          yield* store.stopWaiting(waiting.job, waiting.repo);
      }
    }).pipe(
      Effect.provideService(Store, store),
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
        const paused = yield* store.paused().pipe(Effect.orDie);
        const waiting = yield* store.waiting().pipe(Effect.orDie);

        const machines = yield* store
          .machineRuns(Catalogue.machineJobs.map((job) => job.id))
          .pipe(Effect.orDie);

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
          paused: paused.get(job.id) ?? null,
          waiting: waiting
            .filter((entry) => entry.job === job.id)
            .map(({ run, repo, at }) => ({ run, repo, at })),
          ...(job.machine === true && {
            machine: true,
            machines: machines.get(job.id) ?? [],
          }),
        }));
      }),
      agents: () => store.agents().pipe(Effect.orDie),
      run: Effect.fn(function* ({ params, payload }) {
        const job = findJob(params.id);

        if (Option.isNone(job)) {
          return yield* new Api.JobNotFound({ id: params.id });
        }

        if (job.value.onRelease && payload.release === undefined) {
          return yield* new Api.ReleaseRequired({ id: params.id });
        }

        const repo =
          payload.repo === undefined
            ? null
            : yield* scopeTo(store, job.value, payload.repo);

        const queued = yield* (
          job.value.machine === true
            ? queueMachine(params.id, "manual")
            : queue({
                job: params.id,
                trigger: "manual",
                release: payload.release ?? null,
                repo,
              })
        ).pipe(Effect.provideService(Store, store), Effect.orDie);

        return yield* Option.match(queued, {
          onNone: () =>
            job.value.machine === true
              ? Effect.die(new Error("No worker is live to run it on"))
              : Effect.die(new Error("A manual run wasn't queued")),
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
          yield* queueHeld(params.id).pipe(
            Effect.provideService(Store, store),
            Effect.orDie,
          );
        }
      }),
      pause: Effect.fn(function* ({ params }) {
        if (Option.isNone(findJob(params.id))) {
          return yield* new Api.JobNotFound({ id: params.id });
        }

        const admin = yield* Api.CurrentAdmin;

        yield* store.pause(params.id, admin.name).pipe(Effect.orDie);
        yield* Effect.logInfo(`Paused ${params.id}`).pipe(
          Effect.annotateLogs({ admin: admin.name }),
        );
      }),
      resume: Effect.fn(function* ({ params }) {
        if (Option.isNone(findJob(params.id))) {
          return yield* new Api.JobNotFound({ id: params.id });
        }

        const admin = yield* Api.CurrentAdmin;

        if (yield* store.resume(params.id).pipe(Effect.orDie)) {
          yield* Effect.logInfo(`Resumed ${params.id}`).pipe(
            Effect.annotateLogs({ admin: admin.name }),
          );
          yield* queueHeld(params.id).pipe(
            Effect.provideService(Store, store),
            Effect.orDie,
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
      retry: Effect.fn(function* ({ params }) {
        const admin = yield* Api.CurrentAdmin;

        return yield* Effect.gen(function* () {
          const found = yield* store.run(params.id);

          if (found.state === "queued" || found.state === "running")
            return yield* new Api.RunGoing({
              id: params.id,
              state: found.state,
            });

          const again = {
            job: found.job,
            trigger: "manual" as const,
            release: found.release,
            repo: found.repo ?? null,
          };

          const queued = yield* found.heal === null
            ? queue(again)
            : queue({
                ...again,
                heal: {
                  of: found.heal.of,
                  job: found.heal.job,
                  target: found.heal.target,
                  issue: found.heal.issue,
                },
              });

          yield* store.dismissRun(params.id);

          yield* Effect.logInfo(`Ran ${found.job} again`).pipe(
            Effect.annotateLogs({ run: params.id, admin: admin.name }),
          );

          return yield* Option.match(queued, {
            onNone: () => Effect.die(new Error("A manual run wasn't queued")),
            onSome: Effect.succeed,
          });
        }).pipe(
          Effect.provideService(Store, store),
          Effect.catchTag("StoreError", Effect.die),
        );
      }),
      dismiss: Effect.fn(function* ({ params }) {
        const admin = yield* Api.CurrentAdmin;

        const dismissed = yield* store
          .dismissRun(params.id)
          .pipe(Effect.catchTag("StoreError", Effect.die));

        yield* Effect.logInfo(`Dismissed ${dismissed.job}`).pipe(
          Effect.annotateLogs({ run: params.id, admin: admin.name }),
        );

        return dismissed;
      }),
    });
  }),
);

const ActivityHandlers = HttpApiBuilder.group(
  Api.Api,
  "activity",
  Effect.fn(function* (handlers) {
    const store = yield* Store;

    return handlers.handleAll({
      get: Effect.fn(function* ({ query }) {
        const now = yield* Clock.currentTimeMillis;
        const hours = Math.min(Math.max(query.hours ?? 24, 1), 24 * 30);

        return yield* store
          .activity(now - hours * 3_600_000)
          .pipe(Effect.orDie);
      }),
    });
  }),
);

/** Join counted things into a line: `2 need you, 1 skill change waiting`. */
const counted = (parts: ReadonlyArray<string | null>) =>
  parts.filter((part) => part !== null).join(", ");

/**
 * Upkeep's one status: what needs you (inbox entries that need a person,
 * such as a heal that asked or a parked job, and skill changes waiting for
 * approval), the parked jobs and the live workers.
 */
export const status = Effect.fn("status")(function* () {
  const store = yield* Store;
  const now = yield* Clock.currentTimeMillis;
  const workers = yield* liveWorkers();
  const parked = [...(yield* store.parked()).keys()].toSorted();
  const inbox = yield* store.inbox(now - Api.inboxDays * 86_400_000);

  const entries: ReadonlyArray<Domain.NeedsYou> = inbox.entries
    .filter((entry) => entry.kind === "needs")
    .map((entry) => ({
      kind: "needs",
      title: entry.title,
      path:
        entry.run !== null
          ? `runs/${encodeURIComponent(entry.run)}`
          : entry.job !== null
            ? `jobs/${encodeURIComponent(entry.job)}`
            : "",
      at: entry.lastAt,
    }));

  const changes: ReadonlyArray<Domain.NeedsYou> = (yield* store.skillChanges())
    .filter((change) => change.state === "waiting")
    .map((change) => ({
      kind: "skill-change",
      title: `Skill change waiting: ${change.title}`,
      path: "skills",
      at: change.at,
    }));

  const needs = [...entries, ...changes].toSorted((a, b) => b.at - a.at);

  const health: Domain.Health =
    workers.length === 0 ? "degraded" : needs.length > 0 ? "warning" : "ok";

  const summary =
    needs.length === 0
      ? workers.length === 0
        ? "Nothing needs you, but no worker is live"
        : "Nothing needs you"
      : counted([
          entries.length === 0
            ? null
            : `${entries.length} ${entries.length === 1 ? "thing needs" : "things need"} you`,
          changes.length === 0
            ? null
            : `${changes.length} skill ${changes.length === 1 ? "change" : "changes"} waiting`,
          workers.length === 0 ? "no worker live" : null,
        ]);

  return { health, summary, needs, parked, workers, at: now };
});

const StatusHandlers = HttpApiBuilder.group(
  Api.Api,
  "status",
  Effect.fn(function* (handlers) {
    const store = yield* Store;

    return handlers.handleAll({
      get: () =>
        status().pipe(Effect.provideService(Store, store), Effect.orDie),
      changes: () => Effect.succeed(store.changes),
    });
  }),
);

const InboxHandlers = HttpApiBuilder.group(
  Api.Api,
  "inbox",
  Effect.fn(function* (handlers) {
    const store = yield* Store;

    return handlers.handleAll({
      get: Effect.fn(function* ({ query }) {
        const now = yield* Clock.currentTimeMillis;
        const days = Math.min(Math.max(query.days ?? Api.inboxDays, 1), 30);

        return yield* store.inbox(now - days * 86_400_000).pipe(Effect.orDie);
      }),
      read: ({ payload }) => store.markRead(payload.ids).pipe(Effect.orDie),
      dismiss: ({ params }) =>
        store
          .dismiss(params.id)
          .pipe(Effect.catchTag("StoreError", Effect.die)),
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
        const speaks = payload.protocol ?? 0;

        // An older worker couldn't decode what it would be given, so it gets
        // nothing rather than a run it strands
        if (speaks < Api.protocol) {
          yield* Effect.logWarning(
            `Refused work to ${worker.name}: it's older than the server`,
          ).pipe(
            Effect.annotateLogs({ protocol: speaks, server: Api.protocol }),
          );

          return yield* new Api.WorkerOutdated({
            worker: speaks,
            server: Api.protocol,
          });
        }

        if (payload.agents !== undefined) {
          yield* store
            .setAgents(worker.name, payload.agents)
            .pipe(Effect.orDie);
        }

        const take = Effect.uninterruptible(
          store.claim(payload.jobs, worker.name).pipe(Effect.orDie),
        );

        // Hearing of changes starts before the first look, so a run queued
        // between that look and the wait still wakes it
        const run = yield* Effect.scoped(
          Effect.gen(function* () {
            const changes = yield* store.subscribe;
            const first = yield* take;

            if (Option.isSome(first) || payload.wait === undefined)
              return first;

            return yield* held(
              changes,
              payload.wait,
              ({ topic }) => topic === "runs",
              take,
            );
          }),
        );

        if (Option.isSome(run)) {
          yield* Effect.logInfo(`${worker.name} took ${run.value.job}`).pipe(
            Effect.annotateLogs({ run: run.value.id }),
          );
        }

        return { run: Option.getOrNull(run) };
      }),
      status: () =>
        status().pipe(Effect.provideService(Store, store), Effect.orDie),
      heartbeat: Effect.fn(function* ({ params, query }) {
        const worker = yield* Api.CurrentWorker;

        // Held until the run stops being this worker's, failing then as
        // `RunNotClaimed`, or until the wait is up
        yield* Effect.scoped(
          Effect.gen(function* () {
            const changes = yield* store.subscribe;

            yield* store.heartbeat(params.id, worker.name);

            if (query.wait === undefined) return;

            yield* held(
              changes,
              query.wait,
              (change) => change.topic === "runs" && change.run === params.id,
              store
                .claimed(params.id, worker.name)
                .pipe(Effect.as(Option.none())),
            );
          }),
        ).pipe(Effect.catchTag("StoreError", Effect.die));
      }),
      log: Effect.fn(function* ({ params, payload }) {
        const worker = yield* Api.CurrentWorker;

        yield* store
          .appendLog(params.id, worker.name, payload.lines)
          .pipe(Effect.catchTag("StoreError", Effect.die));
      }),
      finish: Effect.fn(function* ({ params, payload }) {
        const worker = yield* Api.CurrentWorker;

        if (payload.interrupted === true) {
          const requeued = yield* store
            .requeue(params.id, worker.name)
            .pipe(Effect.catchTag("StoreError", Effect.die));

          if (Option.isSome(requeued)) {
            yield* Effect.logInfo(
              `Requeued ${requeued.value.job}: ${worker.name} stopped mid-run`,
            ).pipe(Effect.annotateLogs({ run: params.id }));

            return;
          }
        }

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

        yield* settleWaiting(ended, payload.consumers ?? []).pipe(
          Effect.provideService(Store, store),
          Effect.catchCause(Effect.logError),
        );

        yield* heal(ended, payload.consumers ?? []).pipe(
          Effect.provideService(Store, store),
          Effect.provideService(Triage, triage),
          Effect.catchCause(Effect.logError),
        );
      }),
      report: Effect.fn(function* ({ params, payload }) {
        const worker = yield* Api.CurrentWorker;

        yield* store
          .report(params.id, worker.name, payload)
          .pipe(Effect.catchTag("StoreError", Effect.die));
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
      shareSession: Effect.fn(function* ({ params, payload }) {
        const worker = yield* Api.CurrentWorker;

        yield* store
          .shareSession(params.id, worker.name, payload)
          .pipe(Effect.catchTag("StoreError", Effect.die));
      }),
      session: ({ params }) =>
        store
          .session(params.id)
          .pipe(Effect.catchTag("StoreError", Effect.die)),
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
            repo: run.repo ?? null,
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
              .filter(
                (tracked) =>
                  query.job === undefined || tracked.jobs.includes(query.job),
              )
              .map((tracked) => tracked.repo),
          ),
          Effect.orDie,
        ),
      titles: ({ payload }) =>
        store.setTitles(payload.titles).pipe(Effect.orDie),
      names: ({ payload }) => store.setNames(payload.names).pipe(Effect.orDie),
      inbox: Effect.fn(function* () {
        const now = yield* Clock.currentTimeMillis;

        return yield* store
          .inbox(now - Api.inboxDays * 86_400_000)
          .pipe(Effect.orDie);
      }),
      known: ({ payload }) =>
        store.known(payload.commits).pipe(
          Effect.map((known) => ({ known })),
          Effect.orDie,
        ),
      seen: Effect.fn(function* ({ payload }) {
        const worker = yield* Api.CurrentWorker;

        const added = yield* store.seen(payload.commits).pipe(Effect.orDie);

        if (added > 0) {
          yield* Effect.logInfo(`Added ${added} commits to the inbox`).pipe(
            Effect.annotateLogs({ worker: worker.name }),
          );
        }

        return { added };
      }),
      releases: ({ payload }) =>
        queueReleases(payload.releases, "release").pipe(
          Effect.map((queued) => ({ queued })),
          Effect.provideService(Store, store),
          Effect.orDie,
        ),
      attention: ({ payload }) =>
        store.recordAttention(payload).pipe(Effect.orDie),
      attentionPage: () => store.attention().pipe(Effect.orDie),
      attentionContext: ({ payload }) =>
        store.recordContext(payload).pipe(Effect.orDie),
      skillChanges: () => store.skillChanges().pipe(Effect.orDie),
      skillChange: ({ params }) =>
        store
          .skillChange(params.id)
          .pipe(Effect.catchTag("StoreError", Effect.die)),
      putSkillChange: Effect.fn(function* ({ params, payload }) {
        const worker = yield* Api.CurrentWorker;

        yield* store
          .putSkillChange(params.id, worker.name, payload)
          .pipe(Effect.orDie);
      }),
      skillChangeState: ({ params, payload }) =>
        store
          .setSkillChangeState(params.id, payload)
          .pipe(Effect.catchTag("StoreError", Effect.die)),
      skillCommand: ({ payload }) => queueSkillCommand(store, payload),
      putSkills: ({ payload }) => store.putSkills(payload).pipe(Effect.orDie),
    });
  }),
);

/** Queue a `skill-*` command as a run of the skill-change job. */
const queueSkillCommand = (store: Store["Service"], command: Domain.Command) =>
  store
    .queueRun({
      job: Catalogue.skillChange.id,
      trigger: "manual",
      release: null,
      command,
    })
    .pipe(
      Effect.tap((run) =>
        Effect.logInfo(`Queued ${command.kind}`).pipe(
          Effect.annotateLogs({ run: run.id }),
        ),
      ),
      Effect.orDie,
    );

const AttentionHandlers = HttpApiBuilder.group(
  Api.Api,
  "attention",
  Effect.fn(function* (handlers) {
    const store = yield* Store;

    return handlers.handleAll({
      get: () => store.attention().pipe(Effect.orDie),
      looked: () => store.looked().pipe(Effect.orDie),
      refresh: Effect.fn(function* () {
        const job = Catalogue.attention.id;
        const now = yield* Clock.currentTimeMillis;
        const [last] = yield* store.runs({ job, limit: 1 }).pipe(Effect.orDie);

        const fresh =
          last !== undefined &&
          (last.state === "queued" ||
            last.state === "running" ||
            now - (last.finishedAt ?? last.queuedAt) < Api.attentionRefreshMs);

        if (fresh) return { run: null };

        // Like the schedule, this leaves a paused or parked job alone
        const queued = yield* queue({
          job,
          trigger: "schedule",
          release: null,
        }).pipe(Effect.provideService(Store, store), Effect.orDie);

        return { run: Option.getOrNull(queued) };
      }),
      command: ({ payload }) =>
        payload.kind.startsWith("skill-")
          ? queueSkillCommand(store, payload)
          : store
              .queueRun({
                job: Catalogue.command.id,
                trigger: "manual",
                release: null,
                command: payload,
              })
              .pipe(
                Effect.tap((run) =>
                  Effect.logInfo(`Queued ${payload.kind}`).pipe(
                    Effect.annotateLogs({ run: run.id }),
                  ),
                ),
                // The page shows it read now, not after the next collection
                Effect.tap(() =>
                  payload.kind === "mark-read"
                    ? store.markAttentionRead(payload.thread)
                    : Effect.void,
                ),
                Effect.orDie,
              ),
      hide: ({ payload }) =>
        store.hideAttention(payload.url, payload.hidden).pipe(Effect.orDie),
      createGroup: ({ payload }) =>
        store.createGroup(payload).pipe(Effect.orDie),
      updateGroup: ({ params, payload }) =>
        store
          .updateGroup(params.id, payload)
          .pipe(Effect.catchTag("StoreError", Effect.die)),
      deleteGroup: ({ params }) =>
        store
          .deleteGroup(params.id)
          .pipe(Effect.catchTag("StoreError", Effect.die)),
      link: ({ payload }) =>
        store
          .linkAttention(payload.url, payload.group)
          .pipe(Effect.catchTag("StoreError", Effect.die)),
      addWait: ({ params, payload }) =>
        store
          .addWait(params.id, payload)
          .pipe(Effect.catchTag("StoreError", Effect.die)),
      removeWait: ({ params }) =>
        store.removeWait(params.id).pipe(Effect.orDie),
      comment: Effect.fn(function* ({ payload }) {
        const comment = yield* store
          .commentAttention(payload)
          .pipe(Effect.catchTag("StoreError", Effect.die));

        // The agent reads it on its next run, so start one unless it's queued
        const job = Catalogue.attentionContext.id;
        const [last] = yield* store.runs({ job, limit: 1 }).pipe(Effect.orDie);

        if (last?.state !== "queued") {
          yield* queue({ job, trigger: "manual", release: null }).pipe(
            Effect.provideService(Store, store),
            Effect.orDie,
          );
        }

        return comment;
      }),
      addRule: ({ payload }) => store.addRule(payload.text).pipe(Effect.orDie),
      removeRule: ({ params }) =>
        store.removeRule(params.id).pipe(Effect.orDie),
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
      rename: Effect.fn(function* ({ params, payload }) {
        const admin = yield* Api.CurrentAdmin;
        const repo = `${params.owner}/${params.name}`;

        const renamed = yield* store
          .rename(repo, payload.name)
          .pipe(Effect.orDie);

        if (Option.isNone(renamed)) {
          return yield* new Api.RepoNotTracked({ repo });
        }

        yield* Effect.logInfo(
          payload.name === null
            ? `Cleared the name of ${renamed.value.repo}`
            : `Named ${renamed.value.repo} ${payload.name}`,
        ).pipe(Effect.annotateLogs({ admin: admin.name }));

        return renamed.value;
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

/**
 * The Skills page's actions: each looks the change up first, so one that's
 * gone is a 404, then queues its `skill-*` command or moves it on.
 */
const SkillsHandlers = HttpApiBuilder.group(
  Api.Api,
  "skills",
  Effect.fn(function* (handlers) {
    const store = yield* Store;

    const change = (id: string) =>
      store.skillChange(id).pipe(Effect.catchTag("StoreError", Effect.die));

    return handlers.handleAll({
      get: () => store.skillsPage().pipe(Effect.orDie),
      approve: Effect.fn(function* ({ params }) {
        yield* change(params.id);
        yield* store
          .setSkillChangeState(params.id, { state: "applying" })
          .pipe(Effect.catchTag("StoreError", Effect.die));

        return yield* queueSkillCommand(store, {
          kind: "skill-approve",
          change: params.id,
        });
      }),
      revise: Effect.fn(function* ({ params, payload }) {
        const found = yield* change(params.id);

        return yield* queueSkillCommand(store, {
          kind: "skill-revise",
          change: params.id,
          comment: payload.comment,
          worker: payload.here ? found.worker : null,
        });
      }),
      drop: ({ params }) =>
        store
          .setSkillChangeState(params.id, { state: "dropped" })
          .pipe(Effect.catchTag("StoreError", Effect.die)),
      open: Effect.fn(function* ({ params }) {
        const found = yield* change(params.id);

        return yield* queueSkillCommand(store, {
          kind: "skill-open",
          change: params.id,
          worker: found.worker,
        });
      }),
      request: ({ payload }) =>
        queueSkillCommand(store, {
          kind: "skill-start",
          repo: payload.repo,
          title: payload.skill,
          skills: [payload.skill],
          work: "request",
          reason: payload.prompt,
        }),
    });
  }),
);

const SessionsHandlers = HttpApiBuilder.group(
  Api.Api,
  "sessions",
  Effect.fn(function* (handlers) {
    const store = yield* Store;

    return handlers.handle("get", ({ params }) =>
      store.session(params.id).pipe(Effect.catchTag("StoreError", Effect.die)),
    );
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
      ActivityHandlers,
      StatusHandlers,
      InboxHandlers,
      AttentionHandlers,
      WorkHandlers,
      ReposHandlers,
      SkillsHandlers,
      SessionsHandlers,
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
      if (job.schedule === null || job.machine === true) continue;

      yield* queue({ job: job.id, trigger: "schedule", release: null }).pipe(
        Effect.provideService(Store, store),
        Effect.catchCause(Effect.logError),
        Effect.schedule(Schedule.cron(job.schedule)),
        Effect.forkScoped,
      );
    }
  }),
);

/**
 * Queue each machine job on each live worker whose latest run of it is older
 * than the job's last scheduled time, once a minute. That keeps the schedule
 * and catches a worker up when it comes back after being off.
 */
export const machineScheduler = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Store;

    const crons = Catalogue.machineJobs.flatMap((job) =>
      job.schedule === null
        ? []
        : [{ job: job.id, cron: Cron.parseUnsafe(job.schedule) }],
    );

    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const workers = yield* liveWorkers();
      const latest = yield* store.machineRuns(crons.map(({ job }) => job));

      for (const { job, cron } of crons) {
        const due = Cron.prev(cron, now).getTime();
        const runs = latest.get(job) ?? [];

        for (const worker of workers) {
          const last = runs.find(
            (run) =>
              run.command?.kind === "machine" && run.command.worker === worker,
          );

          if (last !== undefined && last.queuedAt >= due) continue;

          yield* queue({
            job,
            trigger: "schedule",
            release: null,
            command: { kind: "machine", worker },
          });
        }
      }
    }).pipe(
      Effect.provideService(Store, store),
      Effect.catchCause(Effect.logError),
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.forkScoped,
    );
  }),
);

/**
 * Requeue runs whose worker stopped sending heartbeats, or fail them when
 * it's happened to them before, once a minute.
 */
export const lostRuns = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Store;
    const triage = yield* Triage;

    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const lost = yield* store.failLost(now - Duration.toMillis(lostAfter));

      for (const run of lost.requeued) {
        yield* Effect.logWarning(`Requeued ${run.job}, lost once`).pipe(
          Effect.annotateLogs({ run: run.id }),
        );
      }

      for (const run of lost.failed) {
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

/** How often the server pulls GitHub's events from the queue. */
const eventsEvery = Duration.seconds(5);

/** Say what a new GitHub event is about, for the server's log. */
const eventLine = (event: Domain.GitHubEvent) =>
  [
    `${event.event}${event.action === null ? "" : ` ${event.action}`} on ${event.repo}`,
    event.ref,
    event.release?.tag,
    event.workflow === null
      ? undefined
      : `${event.workflow.name} ${event.workflow.conclusion ?? "running"}`,
  ]
    .filter((part) => part !== null && part !== undefined)
    .join(" ");

/**
 * Act on a new GitHub event. A release being published, or a pre-release
 * promoted (`released`), goes through the same path as the releases job's
 * report, so the scheduled run seeing it later queues nothing. A push or a
 * finished workflow run queues the runs `EventJobs.runsFor` asks for, on a
 * tracked repository only: one narrowed to the repository needs it tracked
 * for the job (or at all, for watch). A waiting run is reused, so a burst of
 * pushes queues one. Returns the runs queued.
 */
const handleEvent = Effect.fn("handleEvent")(function* (
  event: Domain.GitHubEvent,
) {
  if (event.event === "release") {
    if (
      event.action !== "released" ||
      event.release === null ||
      event.release.tag === ""
    )
      return [];

    return yield* queueReleases(
      [{ repo: event.repo, tag: event.release.tag, url: event.release.url }],
      "event",
    );
  }

  const store = yield* Store;

  const tracked = (yield* store.repos()).find(
    (repo) => repo.repo.toLowerCase() === event.repo.toLowerCase(),
  );

  const queued: Array<Domain.Run> = [];

  for (const { job: id, repo } of EventJobs.runsFor(event)) {
    const job = Option.getOrNull(findJob(id));

    if (job === null) continue;

    // A narrowed run only goes to a job the repository is tracked for; a run
    // of the whole job, such as sync on a groundwork push, needs neither
    const needs = Catalogue.trackingJob(job);

    if (
      repo !== null &&
      (tracked === undefined ||
        !Catalogue.scopable(job) ||
        (needs !== null && !tracked.jobs.includes(needs)))
    )
      continue;

    const run = yield* queue({
      job: job.id,
      trigger: "event",
      release: null,
      repo: repo === null ? null : (tracked?.repo ?? null),
    });

    if (Option.isSome(run)) queued.push(run.value);
  }

  return queued;
});

/**
 * Pull GitHub's events from the queue every few seconds, record each delivery
 * by its ID so a repeat is dropped, act on it, then ack the batch. A batch
 * that can't be recorded or acted on isn't acked, so it comes back after its
 * visibility timeout, and a delivery that failed is forgotten so it's acted
 * on then. A message that doesn't decode is acked and logged, since it never
 * will.
 */
export const pullEvents = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* Events;
    const store = yield* Store;

    if (!events.enabled) return;

    yield* Effect.gen(function* () {
      const pulled = yield* events.pull();

      for (const message of pulled) {
        if (Option.isNone(message.event)) {
          yield* Effect.logWarning("Dropped an event that didn't decode");
          continue;
        }

        const event = message.event.value;

        if (!(yield* store.recordEvent(event))) continue;

        const queued = yield* handleEvent(event).pipe(
          Effect.provideService(Store, store),
          Effect.onError(() =>
            store.forgetEvent(event.delivery).pipe(Effect.ignore),
          ),
        );

        yield* Effect.logInfo(
          `GitHub event: ${eventLine(event)}${queued.length === 0 ? "" : `, queued ${queued.map((run) => run.job).join(", ")}`}`,
        ).pipe(Effect.annotateLogs({ delivery: event.delivery }));
      }

      yield* events.ack(pulled.map((message) => message.lease));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Couldn't pull GitHub events", cause),
      ),
      Effect.repeat(Schedule.spaced(eventsEvery)),
      Effect.forkScoped,
    );
  }),
);

/** How long a read or dismissed inbox entry is kept after its last change. */
const entryDays = 30;

/**
 * Delete finished runs and their logs past the retention window, once an
 * hour, keeping the latest runs of each job however old they are, and old
 * inbox entries that were read or dismissed.
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

      const entries = yield* store.pruneInbox(
        now - Duration.toMillis(Duration.days(entryDays)),
      );

      if (entries > 0) {
        yield* Effect.logInfo(`Pruned ${entries} old inbox entries`);
      }

      const events = yield* store.pruneEvents(
        now - Duration.toMillis(Duration.days(keep.days)),
      );

      if (events > 0)
        yield* Effect.logInfo(`Pruned ${events} old GitHub events`);
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
 * lost-run, unpark, waiting heal and prune sweeps. For HTTPS, put it behind a
 * reverse proxy, which handles TLS.
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
    machineScheduler,
    lostRuns,
    unparkResolved,
    healWaiting,
    pruneRuns,
    pullEvents,
  ).pipe(
    Layer.provide([Tokens.layer, Triage.layer, Events.layer]),
    Layer.provideMerge(Store.layer),
  );
