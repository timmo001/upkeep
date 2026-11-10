/**
 * The machine jobs: run one `dot up` stage headless on this worker's own
 * machine, so it keeps itself current without anyone running `dot up`. The
 * stage prints what it did as JSON; its log goes to the run's log as it goes.
 * A dotfiles pull is applied by the stow and Herdr stages after it. When a
 * stage changed skills or agent plugins, the agents stage follows to reload
 * running agents. A worker without `dot` has nothing to do.
 */
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { summary } from "../Reporter";
import * as RunLog from "../RunLog";
import { skipped } from "../Worker";

/** The fields of `dot up <stage> --json` the job reads. */
const StageResult = Schema.Struct({
  stage: Schema.String,
  changed: Schema.Boolean,
  failed: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  actions: Schema.Array(
    Schema.Struct({
      status: Schema.String,
      message: Schema.String,
      notable: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  skillsChanged: Schema.Boolean,
  pluginsChanged: Schema.Boolean,
});

type StageResult = typeof StageResult.Type;

export class StageFailed extends Schema.TaggedError<StageFailed>()(
  "StageFailed",
  { stage: Schema.String, error: Schema.String },
) {
  override get message() {
    return `dot up ${this.stage} failed: ${this.error}`;
  }
}

/** Run `dot up <stage> --json`, logging stderr, and decode what it prints. */
const stage = Effect.fnUntraced(function* (name: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const [stdout, code] = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("dot", ["up", name, "--json"], {
          stdin: "ignore",
          extendEnv: true,
          env: { GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
        }),
      );

      const [out, , exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              line.trim() === "" ? Effect.void : RunLog.info(line),
            ),
          ),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );

      return [out, Number(exitCode)] as const;
    }),
  );

  const result = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(StageResult),
  )(stdout).pipe(
    Effect.mapError(
      () =>
        new StageFailed({
          stage: name,
          error: `exited with ${code} without a result`,
        }),
    ),
  );

  if (result.failed)
    return yield* new StageFailed({
      stage: name,
      error: result.error ?? `exited with ${code}`,
    });

  return result;
});

const described = (result: StageResult) =>
  result.actions
    .filter((action) => action.notable === true || action.status === "warn")
    .map((action) => action.message);

/**
 * Upgrade this machine's first-party packages outside a run, for a worker
 * the server refuses as older than itself, which no run can reach. The
 * upkeep package's own upgrade then has the worker drain and restart on the
 * new binary.
 * A machine without `dot`, or without the upgrade set up, is left as it is.
 */
export const selfUpdate = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  yield* Effect.logInfo(
    "Upgrading this machine's first-party packages to catch up with the server",
  );

  const code = yield* Effect.scoped(
    spawner
      .spawn(
        ChildProcess.make("dot", ["up", "first-party", "--json"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          extendEnv: true,
          env: { NO_COLOR: "1" },
        }),
      )
      .pipe(Effect.flatMap((handle) => handle.exitCode)),
  );

  if (Number(code) !== 0)
    yield* Effect.logWarning(`dot up first-party exited with ${code}`);
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Couldn't upgrade this machine's packages", cause),
  ),
);

export const machine = Effect.fnUntraced(function* (name: string) {
  const result = yield* stage(name).pipe(
    Effect.catchTag("PlatformError", (error) =>
      RunLog.info(`dot couldn't run here: ${error.message}`).pipe(
        Effect.as(null),
      ),
    ),
  );

  if (result === null) return skipped;

  const changes = described(result);

  // A dotfiles pull only lands once stow applies it, with the rebuilt dot,
  // and the Herdr stage syncs the machine lists it may have brought
  const applied =
    name === "dotfiles" && result.changed
      ? [yield* stage("stow"), yield* stage("herdr")]
      : [];

  for (const next of applied) changes.push(...described(next));

  if (
    result.skillsChanged ||
    result.pluginsChanged ||
    applied.some((next) => next.skillsChanged)
  ) {
    const agents = yield* stage("agents");

    changes.push(...described(agents));
  }

  if (!result.changed) {
    yield* summary(`Nothing to update for ${name}`);

    return skipped;
  }

  yield* summary(changes.length === 0 ? `Updated ${name}` : changes.join("; "));
});
