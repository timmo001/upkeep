/**
 * Where a running job writes its log: to the server for a run a worker took,
 * or to the console for one run by hand with `upkeep run --local`.
 */
import { Api, Client, Domain } from "@upkeep/api";
import {
  Array as Arr,
  Clock,
  Console,
  Context,
  Effect,
  Layer,
  Ref,
  Schedule,
} from "effect";

const logAt = {
  info: Effect.logInfo,
  warn: Effect.logWarning,
  error: Effect.logError,
} satisfies Record<Domain.LogLevel, (message: string) => Effect.Effect<void>>;

export class RunLog extends Context.Service<
  RunLog,
  {
    readonly write: (
      level: Domain.LogLevel,
      message: string,
    ) => Effect.Effect<void>;
  }
>()("@upkeep/worker/RunLog") {
  /** Print each line, for a run on this machine. */
  static readonly console = Layer.succeed(
    RunLog,
    RunLog.of({
      write: (level, message) =>
        level === "info"
          ? Console.log(message)
          : Console.error(`${level}: ${message}`),
    }),
  );

  /**
   * Send lines to the server in batches every couple of seconds, and the rest
   * when the scope closes. A batch that fails to send is logged and dropped
   * rather than failing the run.
   */
  static readonly remote = (runId: string) =>
    Layer.effect(
      RunLog,
      Effect.gen(function* () {
        const client = yield* Client;
        const pending = yield* Ref.make<ReadonlyArray<Domain.LogEntry>>([]);

        const flush = Effect.gen(function* () {
          const lines = yield* Ref.getAndSet(pending, []);

          for (const batch of Arr.chunksOf(lines, Api.maxLogLines)) {
            yield* client.work.log({
              params: { id: runId },
              payload: { lines: batch },
            });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Couldn't send the run's log", cause),
          ),
        );

        yield* flush.pipe(
          Effect.repeat(Schedule.spaced("2 seconds")),
          Effect.forkScoped,
        );

        yield* Effect.addFinalizer(() => flush);

        return RunLog.of({
          write: Effect.fnUntraced(function* (level, message) {
            const at = yield* Clock.currentTimeMillis;

            yield* Ref.update(pending, Arr.append({ at, level, message }));
            yield* logAt[level](message).pipe(
              Effect.annotateLogs({ run: runId }),
            );
          }),
        });
      }),
    );
}

/** Write an info line to the run's log. */
export const info = (message: string) =>
  RunLog.use((log) => log.write("info", message));

/** Write a warning to the run's log. */
export const warn = (message: string) =>
  RunLog.use((log) => log.write("warn", message));
