/**
 * The worker: it takes runs of the jobs it knows from the server, runs each
 * one while sending heartbeats and its log, and reports how it ended. Nothing
 * a run or the server does stops the loop, so a worker keeps going through a
 * failed job or a server restart.
 */
import { Client, Domain } from "@upkeep/api";
import { Cause, Duration, Effect, Exit, Option, Record, Schema } from "effect";
import { RunLog } from "./RunLog";

/** What a job does when it runs, given the release it's for, if any. */
export type Handler = (
  release: Domain.Release | null,
) => Effect.Effect<void, unknown, RunLog>;

/** The jobs a worker can run, by job ID. */
export type Handlers = Readonly<Record<Domain.JobId, Handler>>;

export interface WorkOptions {
  /** How long to wait before asking again when there's nothing to run. */
  readonly pollInterval?: Duration.Input;
  /** How often to tell the server a run is still going. */
  readonly heartbeatInterval?: Duration.Input;
}

/** The server stopped counting the run as this worker's, so it stops. */
export class RunLost extends Schema.TaggedError<RunLost>()("RunLost", {
  id: Schema.String,
}) {
  override get message() {
    return `The server no longer has run ${this.id} running here`;
  }
}

/** How a run ended, for the server. The cause of a failure is its error. */
const outcome = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit)
    ? { outcome: "succeeded" as const }
    : {
        outcome: "failed" as const,
        error: Cause.hasInterruptsOnly(exit.cause)
          ? "The worker stopped before the run finished"
          : Cause.pretty(exit.cause),
      };

/** Run one claimed run to the end and report how it went. */
const execute = Effect.fnUntraced(function* (
  handler: Handler,
  run: Domain.Run,
  heartbeatInterval: Duration.Input,
) {
  const client = yield* Client;
  const params = { id: run.id };

  // A run the server no longer has as ours, such as one it failed as lost,
  // stops here. Anything else, like the server being down for a moment, is
  // only logged so the run carries on.
  const beat = client.work.heartbeat({ params }).pipe(
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

  const heartbeats = Effect.gen(function* () {
    while (yield* beat) yield* Effect.sleep(heartbeatInterval);

    return yield* new RunLost({ id: run.id });
  });

  yield* Effect.logInfo(`Running ${run.job}`).pipe(
    Effect.annotateLogs({ run: run.id }),
  );

  yield* handler(run.release).pipe(
    Effect.raceFirst(heartbeats),
    Effect.provide(RunLog.remote(run.id)),
    Effect.onExit((exit) =>
      client.work.finish({ params, payload: outcome(exit) }).pipe(
        Effect.andThen(
          Effect.logInfo(`Finished ${run.job}: ${outcome(exit).outcome}`),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Couldn't report how the run ended", cause),
        ),
        Effect.annotateLogs({ run: run.id }),
      ),
    ),
    Effect.ignore,
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
  const heartbeatInterval = options.heartbeatInterval ?? "1 minute";

  yield* Effect.logInfo(`Waiting for runs of ${jobs.join(", ")}`);

  const next = client.work.claim({ payload: { jobs } }).pipe(
    Effect.flatMap(({ run }) =>
      Option.match(Option.fromNullishOr(run), {
        onNone: () => Effect.sleep(pollInterval),
        onSome: (claimed) =>
          execute(
            Option.getOrElse(
              Record.get(handlers, claimed.job),
              (): Handler => () =>
                Effect.fail(`This worker can't run ${claimed.job}`),
            ),
            claimed,
            heartbeatInterval,
          ),
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Couldn't ask the server for work", cause).pipe(
        Effect.andThen(Effect.sleep(pollInterval)),
      ),
    ),
  );

  return yield* Effect.forever(next);
});

/** Run a job on this machine, printing its log, without the server. */
export const runLocal = (handler: Handler, release: Domain.Release | null) =>
  handler(release).pipe(Effect.provide(RunLog.console));
