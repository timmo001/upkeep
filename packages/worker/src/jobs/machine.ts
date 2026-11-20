/**
 * The machine jobs: run one `dot up` stage headless on this worker's own
 * machine, so it keeps itself current without anyone running `dot up`. The
 * stage prints what it did as JSON; its log goes to the run's log as it goes.
 * A dotfiles pull is applied by the stow and Herdr stages after it. When a
 * stage changed skills or agent plugins, the agents stage follows to reload
 * running agents. A worker without `dot` has nothing to do. The settings'
 * `machine.command` runs `dot` some other way, such as over SSH to keep
 * another machine current.
 */
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { summary } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
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
  {
    stage: Schema.String,
    error: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return `dot up ${this.stage} failed: ${this.error}`;
  }
}

/** What runs `up <stage> --json`: the settings' command, or `dot`. */
type Command = readonly [string, ...Array<string>];

const defaultCommand: Command = ["dot"];

/** What Graphviz's `dot` prints when it's given a command it doesn't know. */
const notDotfiles = /Usage: dot \[|graphviz|Error: dot: option/i;

/**
 * Why a stage gave no result, from the last line it printed, since dot's own
 * error comes last: Graphviz's `dot` in its place, when it's run as plain
 * `dot`, or what dot said.
 */
const noResult = (
  command: Command,
  code: number,
  printed: ReadonlyArray<string>,
) => {
  if (
    command.length === 1 &&
    command[0] === "dot" &&
    notDotfiles.test(printed.join("\n"))
  )
    return `${Bun.which("dot") ?? "dot"} is Graphviz, not the dotfiles CLI, so ~/.local/bin isn't on the worker's PATH`;

  const last = printed.findLast((line) => line.trim() !== "")?.trim();

  return last === undefined
    ? `exited with ${code}, printing nothing`
    : `exited with ${code}: ${last}`;
};

/** Run `dot up <stage> --json`, logging stderr, and decode what it prints. */
const stage = Effect.fnUntraced(function* (command: Command, name: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const [head, ...rest] = command;

  const errors: Array<string> = [];

  const [stdout, code] = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(head, [...rest, "up", name, "--json"], {
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
            Stream.runForEach((line) => {
              errors.push(line);

              return line.trim() === "" ? Effect.void : RunLog.info(line);
            }),
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
      (cause) =>
        new StageFailed({
          stage: name,
          error: noResult(command, code, errors),
          cause,
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
 * Catch up with the server, for a worker it refuses as older than itself,
 * which no run can reach: the settings' `machine.selfUpdate`, or an upgrade
 * of this machine's first-party packages outside a run. The upkeep package's
 * own upgrade has the worker drain and restart on the new binary; after a
 * command from the settings succeeds, this says the worker should. A machine
 * without the command, or without the upgrade set up, is left as it is.
 */
export const selfUpdate = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const configured = yield* Settings.loadMachine().pipe(
    Effect.map((machine) => machine?.selfUpdate),
    Effect.orElseSucceed(() => undefined),
  );

  const [head, ...rest] = configured ?? ["dot", "up", "first-party", "--json"];
  const shown = [head, ...rest].join(" ");

  yield* Effect.logInfo(`Running ${shown} to catch up with the server`);

  const code = yield* Effect.scoped(
    spawner
      .spawn(
        ChildProcess.make(head, rest, {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          extendEnv: true,
          env: { NO_COLOR: "1" },
        }),
      )
      .pipe(Effect.flatMap((handle) => handle.exitCode)),
  );

  if (Number(code) !== 0) {
    yield* Effect.logWarning(`${shown} exited with ${code}`);

    return false;
  }

  return configured !== undefined;
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Couldn't catch up with the server", cause).pipe(
      Effect.as(false),
    ),
  ),
);

export const machine = Effect.fnUntraced(function* (name: string) {
  const command = (yield* Settings.loadMachine())?.command ?? defaultCommand;

  const result = yield* stage(command, name).pipe(
    Effect.catchTag("PlatformError", (error) =>
      RunLog.info(`${command[0]} couldn't run here: ${error.message}`).pipe(
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
      ? [yield* stage(command, "stow"), yield* stage(command, "herdr")]
      : [];

  for (const next of applied) changes.push(...described(next));

  if (
    result.skillsChanged ||
    result.pluginsChanged ||
    applied.some((next) => next.skillsChanged)
  ) {
    const agents = yield* stage(command, "agents");

    changes.push(...described(agents));
  }

  if (!result.changed) {
    yield* summary(`Nothing to update for ${name}`);

    return skipped;
  }

  yield* summary(changes.length === 0 ? `Updated ${name}` : changes.join("; "));
});
