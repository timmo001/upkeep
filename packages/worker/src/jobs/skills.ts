/**
 * The skill jobs: run the shared skills repository's own `skill-maintenance`
 * on a worker, so its upkeep runs once, in Upkeep, instead of as a timer on
 * every machine. `skill-consumers` syncs the skill copies the repositories in
 * its `consumers.yml` take, and `skill-updates` hands a completed skill
 * updates workflow run to an agent through its `updates-agent device` mode.
 *
 * Each run builds `skill-maintenance` from a clean checkout of the skills
 * repository's default branch, so it always runs the latest pushed version.
 */
import { Api } from "@timmo001/effect-gh";
import { Effect, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { summary } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { skipped } from "../Worker";
import { cacheRoot as bumpCacheRoot, checkout, run } from "./bump";

const User = Schema.Struct({ login: Schema.String });

const RepositoryInfo = Schema.Struct({ default_branch: Schema.String });

/** `updates-agent device`'s exit when it defers to a later run. */
const deferred = 2;

export class SkillMaintenanceFailed extends Schema.TaggedError<SkillMaintenanceFailed>()(
  "SkillMaintenanceFailed",
  { command: Schema.String, exitCode: Schema.Number },
) {
  override get message() {
    return `skill-maintenance ${this.command} exited with ${this.exitCode}`;
  }
}

/**
 * A clean checkout of the signed-in account's skills repository with
 * `skill-maintenance` built in it. Returns the checkout and the binary.
 */
const build = Effect.fnUntraced(function* () {
  const path = yield* Path.Path;
  const root = path.join(path.dirname(yield* bumpCacheRoot), "skills");
  const { login } = yield* Api.json({ endpoint: "user", method: "GET" }, User);
  const repo = `${login}/skills`;

  const info = yield* Api.json(
    { endpoint: `repos/${repo}`, method: "GET" },
    RepositoryInfo,
  );

  const directory = path.join(root, repo);
  const options = { cwd: directory, trusted: root };

  yield* checkout(repo, info.default_branch, directory, root);
  yield* run(
    "mise",
    ["exec", "--", "bun", "install", "--frozen-lockfile"],
    options,
  );
  yield* run("mise", ["exec", "--", "bun", "run", "build"], options);
  yield* RunLog.info(`Built skill-maintenance from ${repo}`);

  return {
    directory,
    root,
    binary: path.join(directory, "dist", "skill-maintenance"),
  };
});

/**
 * Run `skill-maintenance` in the checkout, writing its output to the run's
 * log as it goes, stdout as info and stderr as warnings. Returns its exit
 * code and the last `[RESULT]` line it printed, if any.
 */
const maintain = Effect.fnUntraced(function* (
  built: {
    readonly directory: string;
    readonly root: string;
    readonly binary: string;
  },
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  let result: string | undefined;

  const lines = (
    stream: Stream.Stream<Uint8Array, unknown>,
    write: (line: string) => Effect.Effect<void, never, RunLog.RunLog>,
  ) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        if (line.startsWith("[RESULT] ")) result = line.slice(9);

        return line.trim() === "" ? Effect.void : write(line);
      }),
    );

  const exitCode = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(built.binary, [...args], {
          cwd: built.directory,
          stdin: "ignore",
          extendEnv: true,
          env: {
            MISE_TRUSTED_CONFIG_PATHS: built.root,
            MISE_YES: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
        }),
      );

      const [, , code] = yield* Effect.all(
        [
          lines(handle.stdout, RunLog.info),
          lines(handle.stderr, RunLog.warn),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );

      return Number(code);
    }),
  );

  return { exitCode, result };
});

/** Sync the skill copies of every repository listed in `consumers.yml`. */
export const skillConsumers = Effect.fnUntraced(function* () {
  const built = yield* build();
  const { exitCode } = yield* maintain(built, ["consumers"]);

  if (exitCode !== 0)
    return yield* new SkillMaintenanceFailed({
      command: "consumers",
      exitCode,
    });

  yield* summary("Synced the shared skills into their consumers");
});

/**
 * Hand the latest completed skill updates workflow run to an agent, with the
 * worker's `skills.updatesAgent` config. A run already processed, or one
 * deferred because another device has it or the checkout has local work, is
 * skipped.
 */
export const skillUpdates = Effect.fnUntraced(function* () {
  const settings = yield* Settings.load();
  const config = settings.skills?.updatesAgent;

  if (config === undefined) {
    yield* RunLog.info(
      "No skills.updatesAgent config on this worker, so there's nothing to run",
    );

    return skipped;
  }

  const built = yield* build();

  const { exitCode, result } = yield* maintain(built, [
    "updates-agent",
    "device",
    "--config",
    config,
  ]);

  if (exitCode === deferred) {
    yield* summary(result ?? "Deferred to a later run");

    return skipped;
  }

  if (exitCode !== 0)
    return yield* new SkillMaintenanceFailed({
      command: "updates-agent device",
      exitCode,
    });

  yield* summary(result ?? "Processed the skill updates");

  if (result?.endsWith(": already processed") === true) return skipped;
});
