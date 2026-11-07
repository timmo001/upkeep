/**
 * The worker: it takes runs of the jobs it knows from the server, runs each
 * one while sending heartbeats and its log, and reports how it ended. Jobs
 * run in lanes, one run per lane at a time, so a long heal doesn't hold up
 * the schedule. Nothing a run or the server does stops a lane, so a worker
 * keeps going through a failed job or a server restart. A run that fails while
 * GitHub's rate limit is spent runs again once it resets, and no lane takes
 * new work until then.
 */
import type { Gh } from "@timmo001/effect-gh";
import { Api, Catalogue, Client, Domain } from "@upkeep/api";
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Option,
  Predicate,
  Record,
  Ref,
  Schedule,
  Schema,
} from "effect";
import type { FileSystem, Path } from "effect";
import { HttpClientError, type HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import { pretty, reason } from "./Failure";
import * as GitHubApp from "./GitHubApp";
import * as Notify from "./Notify";
import * as RateLimits from "./RateLimits";
import { narrowTo, Reporter } from "./Reporter";
import { RunLog } from "./RunLog";
import * as Settings from "./settings";
import * as Status from "./Status";
import * as Theme from "./Theme";

/** What a handler ends with when its run found nothing to do. */
export const skipped = "skipped";

/**
 * What a job does when it runs, given the release it's for and, for a command
 * run, what it's asked to do. It ends with `skipped` when it found nothing to
 * do.
 */
export type Handler = (
  release: Domain.Release | null,
  command: Domain.Command | null,
) => Effect.Effect<
  void | typeof skipped,
  unknown,
  | RunLog
  | Reporter
  | Gh
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
>;

/** The jobs a worker can run, by job ID. */
export type Handlers = Readonly<Record<Domain.JobId, Handler>>;

export interface WorkOptions {
  /** How long to wait before asking again when there's nothing to run. */
  readonly pollInterval?: Duration.Input;
  /**
   * The same for the command lane, shorter so what the dashboard asks for,
   * such as starting an agent, is picked up in seconds.
   */
  readonly commandPollInterval?: Duration.Input;
  /** How often to tell the server a run is still going. */
  readonly heartbeatInterval?: Duration.Input;
}

/** The server stopped counting the run as this worker's, so it stops. */
export class RunLost extends Schema.TaggedError<RunLost>()("RunLost", {
  id: Schema.String,
}) {
  override get message() {
    return `The server no longer has run ${this.id} running here: it was cancelled or lost`;
  }
}

/**
 * Some of a job's consumers failed. The server queues a heal for each one,
 * rather than one for Upkeep itself.
 */
export class ConsumersFailed extends Schema.TaggedError<ConsumersFailed>()(
  "ConsumersFailed",
  { action: Schema.String, repos: Schema.Array(Schema.String) },
) {
  override get message() {
    return `Couldn't ${this.action} ${this.repos.join(", ")}`;
  }
}

/** How a run ended, for the server. The cause of a failure is its error. */
const outcome = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) {
    return {
      outcome:
        exit.value === skipped ? ("skipped" as const) : ("succeeded" as const),
    };
  }

  const failed = Cause.findErrorOption(exit.cause).pipe(
    Option.filter(Schema.is(ConsumersFailed)),
  );

  const interrupted = Cause.hasInterruptsOnly(exit.cause);

  return {
    outcome: "failed" as const,
    error: interrupted
      ? "The worker stopped before the run finished"
      : pretty(exit.cause),
    interrupted,
    ...Option.match(failed, {
      onNone: () => ({}),
      onSome: (error) => ({ consumers: error.repos }),
    }),
  };
};

/** How many times a run that failed on a spent rate limit runs again. */
const limitWaits = 2;

/** What's left of `interval` after `elapsed` milliseconds, or none. */
const remaining = (interval: Duration.Input, elapsed: number) =>
  Duration.millis(Math.max(Duration.toMillis(interval) - elapsed, 0));

/** Run one claimed run to the end and report how it went. */
const execute = Effect.fnUntraced(function* (
  handler: Handler,
  run: Domain.Run,
  heartbeatInterval: Duration.Input,
  hold: (until: number) => Effect.Effect<void>,
  app: GitHubApp.Runs,
) {
  const client = yield* Client;
  const params = { id: run.id };
  const asApp = yield* app.forRun(run.job);

  // A run the server no longer has as ours, such as one it failed as lost or
  // one that was cancelled, stops here. The server holds each heartbeat until
  // the next is due, or ends it early when the run is cancelled. Anything
  // else, like the server being down for a moment, is only logged so the run
  // carries on.
  const beat = client.work
    .heartbeat({
      params,
      query: { wait: Duration.toSeconds(heartbeatInterval) },
    })
    .pipe(
      Effect.as(true),
      Effect.catchTag(["RunNotClaimed", "RunNotFound"], () =>
        Effect.succeed(false),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Couldn't send a heartbeat", error).pipe(
          Effect.as(true),
        ),
      ),
    );

  // An older server answers straight away, so the rest of the interval is
  // waited out here
  const heartbeats = Effect.gen(function* () {
    for (;;) {
      const started = yield* Clock.currentTimeMillis;

      if (!(yield* beat)) break;

      yield* Effect.sleep(
        remaining(
          heartbeatInterval,
          (yield* Clock.currentTimeMillis) - started,
        ),
      );
    }

    return yield* new RunLost({ id: run.id });
  });

  yield* Effect.logInfo(`Running ${run.job}`).pipe(
    Effect.annotateLogs({ run: run.id }),
  );

  // A run that failed while GitHub's rate limit was spent most likely failed
  // on it, so it runs again once the limit resets rather than failing and
  // using up a heal. A heal is left alone: it waits for its agent itself, and
  // mustn't start a second one.
  const attempt = (
    waited: number,
  ): Effect.Effect<
    Effect.Success<ReturnType<Handler>>,
    unknown,
    Effect.Services<ReturnType<Handler>>
  > =>
    handler(run.release, run.command).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (
            waited >= limitWaits ||
            run.job === Catalogue.heal.id ||
            Cause.hasInterruptsOnly(cause)
          )
            return yield* Effect.failCause(cause);

          const reset = yield* RateLimits.spentUntil();

          if (Option.isNone(reset)) return yield* Effect.failCause(cause);

          yield* hold(reset.value);

          const delay = RateLimits.waitUntil(
            reset.value,
            yield* Clock.currentTimeMillis,
          );

          yield* RunLog.use((log) =>
            log.write(
              "warn",
              `Failed while GitHub's rate limit was spent, ${reason(cause)}. Running again after it resets at ${RateLimits.at(reset.value)}, in ${Duration.format(delay)}`,
            ),
          );
          yield* Effect.sleep(delay);

          return yield* attempt(waited + 1);
        }),
      ),
    );

  const scope = run.repo ?? null;

  // A job that runs as the App has its spawner and `gh` swapped for the run,
  // including the rate limit read when it fails, which is the App's then
  const attempts = attempt(0).pipe(Effect.provide(asApp));

  return yield* (
    scope === null
      ? attempts
      : RunLog.use((log) => log.write("info", `Only working on ${scope}`)).pipe(
          Effect.andThen(attempts),
        )
  ).pipe(
    Effect.raceFirst(heartbeats),
    Effect.provide([RunLog.remote(run.id), Reporter.remote(run.id, scope)]),
    Effect.onExit((exit) =>
      client.work.finish({ params, payload: outcome(exit) }).pipe(
        // A server restarting, such as for an upgrade, is back within a
        // minute, and a run whose end isn't reported is only requeued
        Effect.retry({
          while: (error) =>
            HttpClientError.isHttpClientError(error) &&
            Predicate.isTagged(error.reason, "TransportError"),
          schedule: Schedule.exponential("1 second"),
          times: 6,
        }),
        Effect.andThen(
          Effect.logInfo(`Finished ${run.job}: ${outcome(exit).outcome}`),
        ),
        Effect.catchTag("RunNotClaimed", () =>
          Effect.logInfo(`The server had already ended ${run.job}`),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Couldn't report how the run ended", cause),
        ),
        Effect.annotateLogs({ run: run.id }),
      ),
    ),
    Effect.exit,
    Effect.map(Exit.isFailure),
  );
});

/** Take and run jobs from the server until the worker is stopped. */
export const work = Effect.fn("Worker.work")(function* (
  handlers: Handlers,
  options: WorkOptions = {},
) {
  const client = yield* Client;
  const jobs = Record.keys(handlers);
  const pollInterval = options.pollInterval ?? "30 seconds";
  const commandPollInterval = options.commandPollInterval ?? "3 seconds";
  const heartbeatInterval = options.heartbeatInterval ?? "1 minute";

  const status = yield* Status.make;
  const app = yield* GitHubApp.make;

  // When a run finds GitHub's rate limit spent, no lane takes new work until
  // it resets, since nearly every job reads GitHub.
  const heldUntil = yield* Ref.make(0);

  const hold = (until: number) =>
    Ref.update(heldUntil, (current) => Math.max(current, until));

  const holdOff = Effect.gen(function* () {
    const until = yield* Ref.get(heldUntil);
    const now = yield* Clock.currentTimeMillis;

    if (until <= now) return;

    yield* Effect.logInfo(
      `Holding off new runs until GitHub's rate limit resets at ${RateLimits.at(until)}`,
    );
    yield* Effect.sleep(RateLimits.waitUntil(until, now));
  });

  yield* Effect.logInfo(`Waiting for runs of ${jobs.join(", ")}`);
  yield* status.write;

  // What needs a person: parked jobs and heals from the last day that asked.
  const attention = Effect.gen(function* () {
    const since = (yield* Clock.currentTimeMillis) - Duration.toMillis("1 day");
    const parked = yield* client.work.parked();
    const heals = yield* client.work.heals({ query: { since } });

    yield* status.update({
      parked: parked.map(({ job }) => job),
      asking: heals.filter(({ heal }) => heal?.decision === "ask").length,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logDebug("Couldn't read what needs attention", cause),
    ),
  );

  // How the worker is set up to heal, read each time so the dashboard follows
  // its settings. Settings that can't be read leave the last ones shown.
  const agents = Settings.load().pipe(
    Effect.map((settings) => ({ agents: Settings.agentSetup(settings) })),
    Effect.catchCause((cause) =>
      Effect.logDebug("Couldn't read the agents to report", cause).pipe(
        Effect.as({}),
      ),
    ),
  );

  // Each lane's claim is held by the server until a run is queued for it, up
  // to `pollInterval`, so a queued run starts straight away. An older server
  // answers straight away, so the rest of the lane's interval is waited out
  // here. The command lane's is shorter, so it leaves reporting the agents and
  // what needs attention to the others.
  const lane = (name: Domain.Lane, laneJobs: ReadonlyArray<string>) => {
    const command = name === "command";
    const wait = command ? commandPollInterval : pollInterval;

    const next = Effect.gen(function* () {
      yield* holdOff;

      const setup = command ? {} : yield* agents;
      const started = yield* Clock.currentTimeMillis;

      const { run } = yield* client.work.claim({
        payload: {
          jobs: laneJobs,
          protocol: Api.protocol,
          wait: Math.round(Duration.toSeconds(pollInterval)),
          ...setup,
        },
      });

      yield* status.update({ reachable: true });

      return { run, started };
    }).pipe(
      Effect.flatMap(({ run, started }) =>
        Option.match(Option.fromNullishOr(run), {
          onNone: () =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                Effect.sleep(remaining(wait, now - started)),
              ),
              Effect.andThen(command ? Effect.void : attention),
            ),
          onSome: (claimed) =>
            status.started(claimed.job).pipe(
              Effect.andThen(
                execute(
                  Option.getOrElse(
                    Record.get(handlers, claimed.job),
                    (): Handler => () =>
                      Effect.fail(`This worker can't run ${claimed.job}`),
                  ),
                  claimed,
                  heartbeatInterval,
                  hold,
                  app,
                ),
              ),
              Effect.flatMap((failed) => status.finished(claimed.job, failed)),
            ),
        }),
      ),
      Effect.catchTag("WorkerOutdated", (outdated) =>
        Effect.logWarning(`${outdated.message}: update upkeep-git`).pipe(
          Effect.andThen(Effect.sleep(wait)),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Couldn't ask the server for work", cause).pipe(
          Effect.andThen(status.update({ reachable: false })),
          Effect.andThen(Effect.sleep(wait)),
        ),
      ),
    );

    return Effect.forever(next);
  };

  // A job only waits behind the jobs in its own lane; one the catalogue
  // doesn't know takes turns with the jobs that push to repositories.
  const laneOf = (job: string) =>
    Catalogue.jobs.find((known) => known.id === job)?.lane ?? "repos";

  const lanes = Domain.Lane.literals
    .map((name) => [name, jobs.filter((job) => laneOf(job) === name)] as const)
    .filter(([, jobsInLane]) => jobsInLane.length > 0);

  // Telling you what's new that needs you runs beside the lanes, once a minute,
  // and so does following the desktop's Omarchy theme
  const notify = (yield* Notify.make).pipe(
    Effect.repeat(Schedule.spaced("1 minute")),
  );

  return yield* Effect.all(
    [
      ...lanes.map(([name, laneJobs]) => lane(name, laneJobs)),
      notify,
      Theme.follow,
    ],
    {
      concurrency: "unbounded",
      discard: true,
    },
  );
});

/**
 * Run a job on this machine, printing its log, without a worker. `repos`
 * reads the repositories tracked for a job, narrowed to `repo` when given.
 */
export const runLocal = (
  handler: Handler,
  release: Domain.Release | null,
  repos: (job?: Domain.JobId) => Effect.Effect<ReadonlyArray<string>, unknown>,
  repo: string | null = null,
) =>
  handler(release, null).pipe(
    Effect.provide([Reporter.local(narrowTo(repo, repos)), RunLog.console]),
  );
