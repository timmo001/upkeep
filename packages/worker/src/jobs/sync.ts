/**
 * The sync job: keep the copies apps take from groundwork, such as its QML
 * panel components, in step with it, through groundwork's own sync. Apps are
 * the repositories with a `sync.json` at their root, found through code
 * search.
 *
 * Each run clones groundwork and the apps, and runs groundwork's sync over
 * them: an app's edit to a QML copy is carried back into groundwork, then
 * every changed source is copied out. A carried-back edit is checked and
 * pushed to groundwork first, then each changed app is checked, pushed and
 * its CI watched. A copy the sync can't settle, edited in the app and
 * changed in groundwork too, fails its app, so a heal hands it to an agent.
 */
import { Api, Search } from "@timmo001/effect-gh";
import { Catalogue } from "@upkeep/api";
import { Config, Effect, Path, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { reason } from "../Failure";
import * as GitHubApp from "../GitHubApp";
import { listed, pushed, summary, trackedFor } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { ConsumersFailed, skipped } from "../Worker";
import {
  cacheRoot as bumpCacheRoot,
  check,
  checkout,
  commitAndPush,
  run,
  usesMise,
  watch,
} from "./bump";

/** The file at an app's root that names what it takes from groundwork. */
export const syncFile = "sync.json";

const RepositoryInfo = Schema.Struct({
  archived: Schema.Boolean,
  fork: Schema.Boolean,
  default_branch: Schema.String,
});

/** One copy groundwork's sync changed, carried back or flagged. */
const Change = Schema.Struct({
  app: Schema.String,
  path: Schema.String,
  item: Schema.String,
  change: Schema.Literals(["copied", "carried back", "flagged"]),
  reason: Schema.String,
});

export type Change = typeof Change.Type;

const Output = Schema.Struct({ changes: Schema.Array(Change) });

export class SyncFailed extends Schema.TaggedError<SyncFailed>()("SyncFailed", {
  message: Schema.String,
}) {}

/** The sync's commit subject for an app's copies or groundwork's carry-backs. */
export const subject = (
  changes: ReadonlyArray<Change>,
  kind: "copied" | "carried back",
) => {
  const items = [
    ...new Set(
      changes.flatMap((change) =>
        change.change === kind ? [change.item] : [],
      ),
    ),
  ].toSorted();

  return kind === "copied"
    ? `Sync ${items.join(", ")} from groundwork`
    : `Carry ${items.join(", ")} edits back from the apps`;
};

const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

/**
 * Run groundwork's sync CLI over the apps and decode what it changed. It
 * exits 1 when it flags a copy, having still made the rest of its changes,
 * so only a different exit is a failure.
 */
const runSync = Effect.fnUntraced(function* (
  groundwork: string,
  apps: ReadonlyArray<string>,
  options: { readonly trusted: string; readonly dryRun: boolean },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const args = [
    "exec",
    "--",
    "bun",
    "packages/sync/src/cli.ts",
    "run",
    "--json",
    ...(options.dryRun ? ["--check"] : []),
    ...apps.flatMap((app) => ["--app", app]),
  ];

  const [stdout, stderr, exitCode] = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("mise", args, {
          cwd: groundwork,
          stdin: "ignore",
          extendEnv: true,
          env: {
            GROUNDWORK_DIR: groundwork,
            MISE_TRUSTED_CONFIG_PATHS: options.trusted,
            MISE_YES: "1",
            CI: "1",
          },
        }),
      );

      return yield* Effect.all(
        [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
    }),
  );

  if (Number(exitCode) > 1)
    return yield* new SyncFailed({
      message: `groundwork's sync exited with ${exitCode}\n${stderr.trim().split("\n").slice(-20).join("\n")}`,
    });

  const { changes } = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Output),
  )(stdout).pipe(
    Effect.mapError(
      (cause) =>
        new SyncFailed({
          message: `groundwork's sync printed something unexpected: ${String(cause)}`,
        }),
    ),
  );

  return changes;
});

/** Every repository of the signed-in account with a sync.json at its root. */
const repositories = Effect.fnUntraced(function* () {
  const login = yield* GitHubApp.login;

  const results = yield* Search.code({
    query: "items",
    owner: login,
    filename: syncFile,
    limit: 1000,
  }).pipe(
    Effect.retry({ schedule: Schedule.exponential("15 seconds"), times: 4 }),
  );

  return {
    login,
    repos: [
      ...new Set(
        results
          .filter((result) => result.path === syncFile)
          .map((result) => result.repository.nameWithOwner),
      ),
    ].toSorted(),
  };
});

/** Files a checkout has changed, added or removed. */
const changedFiles = (options: {
  readonly cwd: string;
  readonly trusted: string;
}) =>
  run("git", ["status", "--porcelain", "--untracked-files=all"], options).pipe(
    Effect.map((output) =>
      output
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => line.slice(3)),
    ),
  );

interface Context {
  readonly root: string;
  readonly settings: Settings.Settings;
}

/** Check, commit and push a checkout's changes, then watch its CI. */
const push = Effect.fnUntraced(function* (
  repo: string,
  message: string,
  branch: string,
  directory: string,
  context: Context,
) {
  const options = { cwd: directory, trusted: context.root };

  const ran = yield* check(context.settings.bump?.repos?.[repo]?.checks, {
    ...options,
    mise: yield* usesMise(directory),
  });

  yield* ran.length === 0
    ? RunLog.warn(
        `${repo}: has no check or build task, so nothing ran before the push`,
      )
    : RunLog.info(`${repo}: ${ran.join(", ")} passed`);

  yield* run("git", ["add", "--all"], options);

  const sha = yield* commitAndPush(message, branch, options);

  yield* pushed(repo, sha, message);
  yield* RunLog.info(
    `${repo}: pushed ${sha.slice(0, 7)} "${message}", watching CI`,
  );

  const runs = yield* watch(repo, sha);

  yield* RunLog.info(
    runs === 0
      ? `${repo}: no CI ran on ${sha.slice(0, 7)}`
      : `${repo}: CI passed`,
  );
});

/** Sync every app tracked for the job with groundwork. */
export const sync = Effect.fnUntraced(function* () {
  const path = yield* Path.Path;
  const settings = yield* Settings.load();
  const root = path.join(path.dirname(yield* bumpCacheRoot), "sync");
  const context = { root, settings };

  const dryRun = yield* Config.Boolean("UPKEEP_SYNC_DRY_RUN").pipe(
    Config.withDefault(false),
  );

  const tracked = yield* trackedFor(Catalogue.sync.id);
  const { login, repos: found } = yield* repositories();
  const source = `${login}/groundwork`;

  const repos = found.filter(
    (repo) => tracked(repo) && repo.toLowerCase() !== source.toLowerCase(),
  );

  if (repos.length === 0) {
    yield* summary("No app tracked for sync takes anything from groundwork");

    return skipped;
  }

  const failed: Array<string> = [];
  const apps = new Map<string, { branch: string; directory: string }>();

  yield* RunLog.info(
    `${dryRun ? "Dry run: syncing" : "Syncing"} groundwork with ${repos.length} apps`,
  );

  yield* Effect.forEach(
    repos,
    (repo) =>
      Effect.gen(function* () {
        const info = yield* Api.json(
          { endpoint: `repos/${repo}`, method: "GET" },
          RepositoryInfo,
        );

        if (info.archived || info.fork) {
          yield* RunLog.info(
            `${repo}: skipped, ${info.archived ? "archived" : "a fork"}`,
          );

          return;
        }

        const directory = path.join(root, repo);

        yield* checkout(repo, info.default_branch, directory, root);
        apps.set(repo, { branch: info.default_branch, directory });
      }).pipe(
        Effect.catchCause((cause) =>
          RunLog.warn(`${repo}: ${reason(cause)}`).pipe(
            Effect.andThen(Effect.sync(() => failed.push(repo))),
          ),
        ),
      ),
    { concurrency: 4, discard: true },
  );

  const sourceInfo = yield* Api.json(
    { endpoint: `repos/${source}`, method: "GET" },
    RepositoryInfo,
  );

  const groundwork = path.join(root, source);
  const sourceOptions = { cwd: groundwork, trusted: root };

  yield* checkout(source, sourceInfo.default_branch, groundwork, root);
  yield* run(
    "mise",
    ["exec", "--", "bun", "install", "--frozen-lockfile"],
    sourceOptions,
  );

  const byDirectory = new Map(
    [...apps].map(([repo, app]) => [path.resolve(app.directory), repo]),
  );

  const changes = yield* runSync(
    groundwork,
    [...apps.values()].map((app) => app.directory),
    { trusted: root, dryRun },
  );

  const changesOf = (repo: string) =>
    changes.filter(
      (change) => byDirectory.get(path.resolve(change.app)) === repo,
    );

  for (const change of changes) {
    const repo = byDirectory.get(path.resolve(change.app)) ?? change.app;
    const line = `${repo}: ${change.path} ${change.change}, ${change.reason}`;

    yield* change.change === "flagged" ? RunLog.warn(line) : RunLog.info(line);
  }

  if (dryRun) {
    yield* summary(
      changes.length === 0
        ? `Dry run: every copy in ${apps.size} apps is current`
        : `Dry run: ${changes.length} ${changes.length === 1 ? "copy" : "copies"} would change`,
    );

    return;
  }

  // The carried-back edits go to groundwork first, so no app is pushed a
  // copy groundwork doesn't have
  if (changes.some((change) => change.change === "carried back")) {
    yield* push(
      source,
      subject(changes, "carried back"),
      sourceInfo.default_branch,
      groundwork,
      context,
    );
  } else if ((yield* changedFiles(sourceOptions)).length > 0) {
    return yield* new SyncFailed({
      message:
        "groundwork's sync changed groundwork without carrying an edit back",
    });
  }

  const updated: Array<string> = [];

  yield* Effect.forEach(
    [...apps],
    ([repo, app]) =>
      Effect.gen(function* () {
        const own = changesOf(repo);

        if (
          (yield* changedFiles({ cwd: app.directory, trusted: root })).length >
          0
        ) {
          yield* push(
            repo,
            own.some((change) => change.change === "copied")
              ? subject(own, "copied")
              : "Update the groundwork sync lock",
            app.branch,
            app.directory,
            context,
          );

          updated.push(repo);
        }

        const flagged = own.filter((change) => change.change === "flagged");

        if (flagged.length > 0)
          return yield* new SyncFailed({
            message: `${flagged.map((change) => change.path).join(", ")} changed in both the app and groundwork: move the app's edit into groundwork or a wrapper, then run groundwork's sync`,
          });
      }).pipe(
        Effect.catchCause((cause) =>
          RunLog.warn(`${repo}: ${reason(cause)}`).pipe(
            Effect.andThen(Effect.sync(() => failed.push(repo))),
          ),
        ),
      ),
    { concurrency: 2, discard: true },
  );

  yield* summary(
    updated.length === 0 && failed.length === 0
      ? `Every copy in ${apps.size} apps is current`
      : `Synced ${listed(updated)} with groundwork, ${listed(failed)} need attention`,
  );

  if (failed.length > 0)
    return yield* new ConsumersFailed({
      action: "sync",
      repos: failed.toSorted(),
    });
});
