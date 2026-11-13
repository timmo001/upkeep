/**
 * The bump job: roll a release out to the repositories that use it. Consumers
 * are found through code search, from workflow pins of the released
 * repository and from `package.json` dependencies on the packages it
 * publishes, and by reading the tracked repositories' `package.json` files
 * too, since code search can miss repositories or come back empty. Each one
 * is checked out in a worktree, edited, checked and
 * pushed straight to its default branch, then its CI is watched. A consumer
 * that opts in to regression checks runs them before the push when the
 * release needs one, or has the update held for an agent. A consumer that
 * fails is logged and the rest carry on; the run fails at the end, naming
 * them. Consumers start as soon as what they need is published, and only the
 * work on their worktrees is limited to four at a time, so a slow CI run
 * doesn't hold up the next push.
 */
import { Api, Repository, Search } from "@timmo001/effect-gh";
import { Catalogue, type Domain } from "@upkeep/api";
import {
  Cache,
  Clock,
  Config,
  Data,
  Duration,
  Effect,
  FileSystem,
  Match,
  Option,
  Path,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import { HttpClient } from "effect/http";
import { run } from "../Command";
import * as CiTimings from "../CiTimings";
import { reason } from "../Failure";
import * as GitHubApp from "../GitHubApp";
import * as RateLimits from "../RateLimits";
import * as RunLog from "../RunLog";
import { listed, pushed, summary, trackedRepos } from "../Reporter";
import * as Regression from "../Regression";
import * as Settings from "../settings";
import { ConsumersFailed, HandedOff, skipped } from "../Worker";
import * as Worktrees from "../Worktrees";

// Other jobs and the tests still reach these through the bump job
export { failedOutput, run } from "../Command";

/** What a release changes in a consumer. */
export type Edit = Data.TaggedEnum<{
  /** Workflow and action pins of the released repository, in `.github/`. */
  Pins: { readonly repo: string; readonly sha: string; readonly tag: string };
  /** A dependency on a package it publishes, in each `package.json`. */
  Dependency: { readonly name: string; readonly version: string };
}>;

export const Edit = Data.taggedEnum<Edit>();

const escape = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);

/**
 * A file's text with an edit applied. Pins move to the release's commit with
 * its tag as a comment; a dependency keeps its `^` or `~` and only changes
 * when it's a version, not a workspace, path or git spec.
 */
export const rewrite = (edit: Edit, text: string) =>
  Edit.$match(edit, {
    Pins: ({ repo, sha, tag }) =>
      text.replace(
        new RegExp(
          String.raw`(${escape(repo)}/\.github/(?:workflows|actions)/[^@\s]+)@[0-9a-f]{40}(?: *#[^\n]*)?`,
          "g",
        ),
        `$1@${sha} # ${tag}`,
      ),
    Dependency: ({ name, version }) =>
      text.replace(
        new RegExp(
          String.raw`("${escape(name)}"\s*:\s*")([~^]?)\d[^"]*(")`,
          "g",
        ),
        `$1$2${version}$3`,
      ),
  });

/**
 * The versions a file depends on a package at, before `rewrite` moves them,
 * without their `^` or `~`. Workspace, path and git specs aren't versions.
 */
export const currentVersions = (name: string, text: string) =>
  [
    ...text.matchAll(
      new RegExp(String.raw`"${escape(name)}"\s*:\s*"[~^]?(\d[^"]*)"`, "g"),
    ),
  ].flatMap((match) => match[1] ?? []);

/**
 * A release's changes since a consumer's version, when its tag names the
 * version, such as `v1.2.0` or `pkg@1.2.0`.
 */
export const compareLink = (
  release: Domain.Release,
  from: string,
  to: string,
) =>
  release.tag.includes(to)
    ? `https://github.com/${release.repo}/compare/${release.tag.replace(to, from)}...${release.tag}`
    : undefined;

/** The tracked files an edit can change, as `git ls-files` pathspecs. */
const pathspecs = (edit: Edit) =>
  Edit.$match(edit, {
    Pins: () => [".github/*.yml", ".github/*.yaml"],
    Dependency: () => ["package.json", "*/package.json"],
  });

/** How the commit names the change. */
const describe = (edit: Edit) =>
  Edit.$match(edit, {
    Pins: ({ repo, tag }) => `${repo} to ${tag}`,
    Dependency: ({ name, version }) => `${name} to ${version}`,
  });

class CiFailed extends Schema.TaggedError<CiFailed>()("CiFailed", {
  runs: Schema.Array(Schema.String),
}) {
  override get message() {
    return `CI failed after the push:\n${this.runs.join("\n")}`;
  }
}

class CiTimedOut extends Schema.TaggedError<CiTimedOut>()("CiTimedOut", {
  sha: Schema.String,
  after: Schema.String,
}) {
  override get message() {
    return `CI on ${this.sha.slice(0, 7)} was still going after ${this.after}`;
  }
}

class NoRelease extends Schema.TaggedError<NoRelease>()("NoRelease", {}) {
  override get message() {
    return "The bump job runs for a release; give one with --release";
  }
}

const Commit = Schema.Struct({ sha: Schema.String });

const RepositoryInfo = Schema.Struct({
  archived: Schema.Boolean,
  fork: Schema.Boolean,
  default_branch: Schema.String,
});

const Tree = Schema.Struct({
  tree: Schema.Array(
    Schema.Struct({ path: Schema.String, type: Schema.String }),
  ),
});

const Manifest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  private: Schema.optionalKey(Schema.Boolean),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String),
  ),
  peerDependencies: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String),
  ),
  optionalDependencies: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String),
  ),
});

const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Manifest),
);

/**
 * Code search allows a handful of requests a minute, so back off on a limit.
 * It runs with the machine's login, since the App's token drops results.
 */
const search = (input: Search.CodeInput) =>
  GitHubApp.withMachineLogin(Search.code({ ...input, limit: 1000 })).pipe(
    Effect.retry({ schedule: Schedule.exponential("15 seconds"), times: 4 }),
    Effect.map((results) => [
      ...new Set(results.map((result) => result.repository.nameWithOwner)),
    ]),
  );

/**
 * The npm packages the release publishes, from its `package.json` files, each
 * with the release's other packages it depends on. Dev dependencies are left
 * out, as consumers don't install them.
 */
const packages = Effect.fnUntraced(function* (release: Domain.Release) {
  const { tree } = yield* Api.json(
    {
      endpoint: `repos/${release.repo}/git/trees/${release.tag}?recursive=1`,
      method: "GET",
    },
    Tree,
  );

  const found: Array<{
    readonly name: string;
    readonly version: string;
    readonly dependencies: ReadonlyArray<string>;
  }> = [];

  const manifests = tree.filter(
    (entry) =>
      entry.type === "blob" &&
      /(^|\/)package\.json$/.test(entry.path) &&
      !entry.path.includes("node_modules/"),
  );

  for (const entry of manifests) {
    const manifest = yield* Repository.readFile({
      repo: release.repo,
      path: entry.path,
      ref: release.tag,
    }).pipe(Effect.flatMap(decodeManifest));

    if (
      manifest.private !== true &&
      manifest.name !== undefined &&
      manifest.version !== undefined &&
      manifest.version !== "0.0.0"
    ) {
      found.push({
        name: manifest.name,
        version: manifest.version,
        dependencies: Object.keys({
          ...manifest.dependencies,
          ...manifest.peerDependencies,
          ...manifest.optionalDependencies,
        }),
      });
    }
  }

  const names = new Set(found.map(({ name }) => name));

  return found.map((manifest) => ({
    ...manifest,
    dependencies: manifest.dependencies.filter(
      (name) => name !== manifest.name && names.has(name),
    ),
  }));
});

/**
 * A package and every package of the release it depends on, directly or
 * through another, which all have to be on npm before it installs.
 */
export const needed = (
  name: string,
  dependencies: ReadonlyMap<string, ReadonlyArray<string>>,
) => {
  const seen = new Set<string>();
  const pending = [name];

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;

    seen.add(next);
    pending.push(...(dependencies.get(next) ?? []));
  }

  return [...seen];
};

/**
 * Wait for a version to reach npm, since the release usually starts the
 * publish. Checks every 15 seconds and gives up after 20 minutes, warning
 * that its consumers are left.
 */
const published = Effect.fnUntraced(function* (name: string, version: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const response = yield* HttpClient.get(
      `https://registry.npmjs.org/${name}/${version}`,
    );

    if (response.status === 200) {
      if (attempt > 0) yield* RunLog.info(`${name}@${version} is on npm`);

      return true;
    }

    if (attempt === 0) {
      yield* RunLog.info(`Waiting for ${name}@${version} to reach npm`);
    }

    yield* Effect.sleep("15 seconds");
  }

  yield* RunLog.warn(
    `${name}@${version} isn't on npm after 20 minutes, so its consumers are left`,
  );

  return false;
});

/**
 * The tracked repositories whose `package.json` files, on their default
 * branch, name each of the packages, read directly. Code search finds the
 * same, but can miss repositories or return nothing at all, which would
 * leave consumers on the old version without a word. A repository that
 * can't be read is logged and left to code search.
 */
const manifestUsers = Effect.fnUntraced(function* (
  repos: ReadonlyArray<string>,
  names: ReadonlyArray<string>,
) {
  const wanted = new Set(names);
  const users = new Map<string, Set<string>>();

  yield* Effect.forEach(
    repos,
    (repo) =>
      Effect.gen(function* () {
        const { tree } = yield* Api.json(
          {
            endpoint: `repos/${repo}/git/trees/HEAD?recursive=1`,
            method: "GET",
          },
          Tree,
        );

        const manifests = tree.filter(
          (entry) =>
            entry.type === "blob" &&
            /(^|\/)package\.json$/.test(entry.path) &&
            !entry.path.includes("node_modules/"),
        );

        for (const entry of manifests) {
          const manifest = yield* Repository.readFile({
            repo,
            path: entry.path,
          }).pipe(Effect.flatMap(decodeManifest));

          const named = Object.keys({
            ...manifest.dependencies,
            ...manifest.devDependencies,
            ...manifest.peerDependencies,
            ...manifest.optionalDependencies,
          });

          for (const name of named) {
            if (!wanted.has(name)) continue;

            users.set(name, new Set([...(users.get(name) ?? []), repo]));
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          RunLog.warn(
            `Couldn't read ${repo}'s package.json files, so only code search finds it: ${reason(cause)}`,
          ),
        ),
      ),
    { concurrency: 6, discard: true },
  );

  return users;
});

/**
 * Every consumer of the release and what changes in each, found before any
 * package reaches npm. Each package's wait for npm runs once, from when the
 * first consumer needs it, and is shared by the rest.
 */
const discover = Effect.fnUntraced(function* (
  release: Domain.Release,
  sha: string,
  tracked: ReadonlyArray<string>,
) {
  const [owner = ""] = release.repo.split("/");
  const consumers = new Map<string, Array<Edit>>();
  const toPublish = yield* packages(release);

  const onNpm = new Map(
    yield* Effect.forEach(toPublish, ({ name, version }) =>
      Effect.cached(
        published(name, version).pipe(
          Effect.catchCause((cause) =>
            RunLog.warn(
              `Couldn't check npm for ${name}@${version}: ${reason(cause)}`,
            ).pipe(Effect.as(false)),
          ),
        ),
      ).pipe(Effect.map((wait) => [name, wait] as const)),
    ),
  );

  const add = (repos: ReadonlyArray<string>, edit: Edit) => {
    for (const repo of repos) {
      if (repo === release.repo) continue;

      consumers.set(repo, [...(consumers.get(repo) ?? []), edit]);
    }
  };

  add(
    yield* search({ query: `${release.repo}/.github/`, owner }),
    Edit.Pins({ repo: release.repo, sha, tag: release.tag }),
  );

  const read = yield* manifestUsers(
    tracked,
    toPublish.map(({ name }) => name),
  );

  for (const { name, version } of toPublish) {
    // gh escapes quotes inside a quoted term, and code search can then report
    // matches but return no items, so the name goes in bare
    const searched = yield* search({
      query: name,
      owner,
      filename: "package.json",
    });

    // Once each, ignoring case as GitHub does, by code search's spelling
    const users = new Map<string, string>();

    for (const repo of [...searched, ...(read.get(name) ?? [])]) {
      if (!users.has(repo.toLowerCase())) users.set(repo.toLowerCase(), repo);
    }

    add([...users.values()], Edit.Dependency({ name, version }));
  }

  return {
    consumers,
    onNpm,
    dependencies: new Map(
      toPublish.map(({ name, dependencies }) => [name, dependencies] as const),
    ),
  };
});

/**
 * A consumer's edits once the packages they need are on npm: pins at once,
 * dependencies as their package and the release's packages it depends on
 * land, dropping any where one never does.
 */
const ready = <R>(
  edits: ReadonlyArray<Edit>,
  onNpm: ReadonlyMap<string, Effect.Effect<boolean, never, R>>,
  dependencies: ReadonlyMap<string, ReadonlyArray<string>>,
) =>
  Effect.filter(
    edits,
    (edit) =>
      Edit.$is("Dependency")(edit)
        ? Effect.forEach(
            needed(edit.name, dependencies),
            (name) => onNpm.get(name) ?? Effect.succeed(false),
            { concurrency: "unbounded" },
          ).pipe(Effect.map((landed) => landed.every(Boolean)))
        : Effect.succeed(true),
    { concurrency: "unbounded" },
  );

/**
 * Each lockfile, the package manager that writes it and its install. CI is
 * set, which makes pnpm freeze the lockfile the bump has to change.
 */
const lockfiles: ReadonlyArray<
  readonly [string, string, ReadonlyArray<string>]
> = [
  ["bun.lock", "bun", ["install"]],
  ["bun.lockb", "bun", ["install"]],
  ["pnpm-lock.yaml", "pnpm", ["install", "--no-frozen-lockfile"]],
  ["package-lock.json", "npm", ["install"]],
  ["yarn.lock", "yarn", ["install"]],
];

const lockfileIn = Effect.fnUntraced(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  for (const entry of lockfiles) {
    if (yield* fs.exists(path.join(folder, entry[0]))) return entry;
  }

  return undefined;
});

/** Run a command through mise when the repository pins its tools. */
export const tool = (
  mise: boolean,
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly trusted: string },
) =>
  mise
    ? run("mise", ["exec", "--", command, ...args], options)
    : run(command, args, options);

/**
 * Install where a changed manifest has a lockfile, in its own directory or
 * the repository's root. Returns the lockfiles to commit.
 */
export const install = Effect.fnUntraced(function* (
  directory: string,
  manifests: ReadonlyArray<string>,
  options: { readonly trusted: string; readonly mise: boolean },
) {
  const path = yield* Path.Path;
  const done = new Set<string>();

  for (const manifest of manifests) {
    for (const folder of [path.dirname(manifest), "."]) {
      const found = yield* lockfileIn(path.join(directory, folder));

      if (found === undefined) continue;

      const lockfile = path.join(folder, found[0]);

      if (!done.has(lockfile)) {
        yield* tool(options.mise, found[1], found[2], {
          cwd: path.join(directory, folder),
          trusted: options.trusted,
        });

        done.add(lockfile);
      }

      break;
    }
  }

  return [...done];
});

/**
 * Move one dependency to a version within its range in the lockfile beside
 * its manifest, as Renovate's update-lockfile does: pnpm updates without
 * saving, Yarn upgrades to the newest release in the range, and Bun and npm,
 * which save the version to the manifest too, have it put back and install
 * again to keep the range.
 */
export const updateLocked = Effect.fnUntraced(function* (
  directory: string,
  manifest: string,
  lockfile: string,
  dependency: { readonly name: string; readonly version: string },
  options: { readonly trusted: string; readonly mise: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entry = lockfiles.find(([name]) => name === path.basename(lockfile));

  if (entry === undefined) return;

  const [, manager, reinstall] = entry;
  const pinned = `${dependency.name}@${dependency.version}`;
  const file = path.join(directory, manifest);
  const before = yield* fs.readFileString(file);

  // Berry's lockfile has its metadata at the top level, Yarn 1's doesn't
  const berry =
    manager === "yarn" &&
    /^__metadata:/m.test(
      yield* fs.readFileString(path.join(directory, lockfile)),
    );

  const args = Match.value(manager).pipe(
    Match.when("pnpm", () => ["update", "--no-save", pinned]),
    Match.when("yarn", () =>
      berry ? ["up", "-R", dependency.name] : ["upgrade", dependency.name],
    ),
    Match.when("npm", () => ["install", "--no-audit", pinned]),
    Match.orElse(() => ["update", pinned]),
  );

  yield* tool(options.mise, manager, args, {
    cwd: path.dirname(file),
    trusted: options.trusted,
  });

  if ((yield* fs.readFileString(file)) === before) return;

  yield* fs.writeFileString(file, before);

  yield* tool(options.mise, manager, reinstall, {
    cwd: path.join(directory, path.dirname(lockfile)),
    trusted: options.trusted,
  });
});

/**
 * Whether `regenerate` can write a lockfile afresh. bun.lockb isn't one, as
 * Bun now writes a text bun.lock in its place.
 */
export const regenerates = (lockfile: string) =>
  lockfiles.some(
    ([name]) => name !== "bun.lockb" && lockfile.split("/").at(-1) === name,
  );

/**
 * Delete a lockfile and install again, as Renovate's lock file maintenance
 * does, so everything the manifests allow moves to its latest.
 */
export const regenerate = Effect.fnUntraced(function* (
  directory: string,
  lockfile: string,
  options: { readonly trusted: string; readonly mise: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entry = lockfiles.find(([name]) => name === path.basename(lockfile));

  if (entry === undefined || !regenerates(lockfile)) return;

  yield* fs.remove(path.join(directory, lockfile));

  yield* tool(options.mise, entry[1], entry[2], {
    cwd: path.join(directory, path.dirname(lockfile)),
    trusted: options.trusted,
  });
});

/** The repository's own mise tasks, leaving out global ones. */
export const miseTasks = (options: {
  readonly cwd: string;
  readonly trusted: string;
}) =>
  run("mise", ["tasks", "ls", "--no-global", "--name-only"], options).pipe(
    Effect.map((output) => output.split("\n").map((line) => line.trim())),
  );

/**
 * Run the commands set to rebuild a repository's committed files, such as
 * bundles built from its dependencies, and log them. Returns every tracked
 * file the checkout now changes, so what they wrote goes in the commit; new
 * untracked files are left out.
 */
export const generate = Effect.fnUntraced(function* (
  repo: string,
  commands: ReadonlyArray<string> | undefined,
  options: { readonly cwd: string; readonly trusted: string },
) {
  if (commands === undefined || commands.length === 0) return [];

  for (const command of commands) yield* run("sh", ["-c", command], options);

  const changed = (yield* run("git", ["diff", "--name-only"], options))
    .split("\n")
    .filter((file) => file !== "");

  yield* RunLog.info(`${repo}: ${commands.join(", ")} ran`);

  return changed;
});

/**
 * The checks before a push: the commands set for the repository, or else
 * its mise `check` and `build` tasks where it has them. Returns what ran.
 */
export const check = Effect.fnUntraced(function* (
  configured: ReadonlyArray<string> | undefined,
  options: {
    readonly cwd: string;
    readonly trusted: string;
    readonly mise: boolean;
  },
) {
  if (configured !== undefined) {
    for (const command of configured)
      yield* run("sh", ["-c", command], options);

    return configured;
  }

  if (!options.mise) return [];

  const tasks = yield* miseTasks(options);

  const ran: Array<string> = [];

  for (const task of ["check", "build"]) {
    if (!tasks.includes(task)) continue;

    // The clone was cleaned, but mise keeps what it last ran outside it, so
    // without --force it skips installs whose output is gone
    yield* run("mise", ["run", "--force", task], options);
    ran.push(`mise run ${task}`);
  }

  return ran;
});

const passed = new Set(["success", "skipped", "neutral"]);

const Comparison = Schema.Struct({ status: Schema.String });

/**
 * The newer head of a branch that has moved on from a commit while keeping
 * it, or `undefined` when it hasn't.
 */
const movedOn = Effect.fnUntraced(function* (
  repo: string,
  branch: string,
  sha: string,
) {
  const head = yield* RateLimits.waitOut(
    Api.json(
      { endpoint: `repos/${repo}/commits/${branch}`, method: "GET" },
      Commit,
    ),
    `${repo}: reading ${branch}`,
  );

  if (head.sha === sha) return undefined;

  const { status } = yield* RateLimits.waitOut(
    Api.json(
      { endpoint: `repos/${repo}/compare/${sha}...${head.sha}`, method: "GET" },
      Comparison,
    ),
    `${repo}: comparing ${branch}`,
  );

  return status === "ahead" ? head.sha : undefined;
});

/**
 * Wait for the CI runs on a pushed commit to finish, failing when one does.
 * Returns how many ran; none have started after two minutes means none. The
 * first look comes when the repository's CI is usually nearly done, and the
 * looks after it at a pace that fits it, from {@link CiTimings}.
 *
 * A workflow that cancels runs in progress cancels this commit's when another
 * push lands on the branch straight after, so when only cancelled runs failed
 * and the branch has moved on with this commit in it, the newer commit's CI
 * is watched instead.
 */
export const watch = Effect.fnUntraced(function* (
  repo: string,
  commit: string,
) {
  const { first, every, within } = CiTimings.pace(
    yield* CiTimings.typical(repo),
  );

  const started = yield* Clock.currentTimeMillis;
  const deadline = started + Duration.toMillis(within);
  let sha = commit;
  let since = started;
  let wait = first;

  let previous:
    | {
        readonly runs: ReadonlyArray<CiTimings.ApiRun>;
        readonly validators: Api.Validators;
      }
    | undefined;

  while ((yield* Clock.currentTimeMillis) < deadline) {
    yield* Effect.sleep(wait);
    wait = every;

    // Sent with the last look's validators, so a look that finds nothing
    // changed costs no rate limit
    const response = yield* RateLimits.waitOut(
      Api.conditional(
        {
          endpoint: `repos/${repo}/actions/runs`,
          query: { head_sha: sha, per_page: 50 },
        },
        CiTimings.ApiRuns,
        previous?.validators,
      ),
      `${repo}: watching CI`,
    );

    previous = Api.Conditional.$match(response, {
      Modified: ({ value, validators }) => ({
        runs: value.workflow_runs,
        validators,
      }),
      NotModified: () => previous ?? { runs: [], validators: {} },
    });

    const runs = previous.runs.map(CiTimings.toRun);

    if (runs.length === 0) {
      if ((yield* Clock.currentTimeMillis) - since >= 120_000) return 0;

      continue;
    }

    if (runs.some((item) => item.status !== "completed")) continue;

    yield* CiTimings.record(repo, previous.runs);

    const failed = runs.filter((item) => !passed.has(item.conclusion ?? ""));
    const branch = failed[0]?.headBranch ?? null;

    const newer =
      failed.length > 0 &&
      branch !== null &&
      failed.every(
        (item) => item.conclusion === "cancelled" && item.headBranch === branch,
      )
        ? yield* movedOn(repo, branch, sha)
        : undefined;

    if (newer !== undefined) {
      yield* RunLog.info(
        `${repo}: CI on ${sha.slice(0, 7)} was cancelled by a later push, watching ${newer.slice(0, 7)} instead`,
      );

      sha = newer;
      since = yield* Clock.currentTimeMillis;
      previous = undefined;

      continue;
    }

    if (failed.length > 0) {
      return yield* new CiFailed({
        runs: failed.map(
          (item) =>
            `${item.workflowName ?? item.name}: ${item.conclusion ?? "no conclusion"} ${item.url}`,
        ),
      });
    }

    return runs.length;
  }

  return yield* new CiTimedOut({ sha, after: Duration.format(within) });
});

/**
 * Commit what's staged and push it to the default branch. When the branch
 * moved while the job ran, the commit is replayed on it once. Returns the
 * pushed commit.
 *
 * A fresh clone has none of the repository's git hooks, so anything one does
 * after a commit, such as refreshing a pinned hash and committing it, would
 * never happen. When the repository has a mise `install:hooks` task, it runs
 * first, so the commit runs the hooks as it would on a person's checkout and
 * the push takes any commit they add.
 */
export const commitAndPush = Effect.fnUntraced(function* (
  message: string,
  branch: string,
  options: { readonly cwd: string; readonly trusted: string },
) {
  const push = run(
    "git",
    ["push", "--quiet", "origin", `HEAD:${branch}`],
    options,
  );

  if (
    (yield* usesMise(options.cwd)) &&
    (yield* miseTasks(options)).includes("install:hooks")
  )
    yield* run("mise", ["run", "install:hooks"], options);

  yield* run(
    "git",
    ["commit", "--quiet", "-m", message, ...(yield* GitHubApp.coAuthorTrailer)],
    options,
  );

  yield* push.pipe(
    Effect.catch(() =>
      run(
        "git",
        ["pull", "--rebase", "--quiet", "origin", branch],
        options,
      ).pipe(Effect.andThen(push)),
    ),
  );

  return (yield* run("git", ["rev-parse", "HEAD"], options)).trim();
});

/** Whether a repository pins its tools with mise. */
export const usesMise = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return (
    (yield* fs.exists(path.join(directory, "mise.toml"))) ||
    (yield* fs.exists(path.join(directory, ".mise.toml")))
  );
});

const ReleaseNotes = Schema.Struct({
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/**
 * A release's notes, empty when it has none, or `undefined` when they
 * couldn't be read, which is logged.
 */
const readNotes = (release: Domain.Release) =>
  Api.json(
    {
      endpoint: `repos/${release.repo}/releases/tags/${release.tag}`,
      method: "GET",
    },
    ReleaseNotes,
  ).pipe(
    Effect.map(({ body }): string | undefined => body ?? ""),
    Effect.catchCause((cause) =>
      RunLog.warn(
        `Couldn't read the release notes of ${release.repo} ${release.tag}: ${reason(cause)}`,
      ).pipe(Effect.as(undefined)),
    ),
  );

type Outcome = "updated" | "current" | "skipped" | "held";

interface BumpContext {
  readonly release: Domain.Release;
  /** The release's notes, read once for the run by the first consumer that needs them. */
  readonly notes: ReturnType<typeof readNotes>;
  /**
   * The decision model's verdict on a version change the rules can't settle,
   * asked once per run for each change, as the notes are the same for every
   * consumer.
   */
  readonly decide: (
    change: Moved | undefined,
  ) => Effect.Effect<Option.Option<Regression.Decided>>;
  /** The run's worktrees, and the path mise is told to trust. */
  readonly worktrees: Worktrees.Run;
  readonly settings: Settings.Settings;
  readonly dryRun: boolean;
  /** Holds one of the four slots for local work: clone, install, check, push. */
  readonly slot: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

/**
 * Apply a consumer's edits, check and push, then watch its CI. Only the work
 * on the clone holds a slot, so watching CI doesn't hold up the next push.
 */
const bumpRepository = Effect.fnUntraced(function* (
  repo: string,
  edits: ReadonlyArray<Edit>,
  context: BumpContext,
) {
  const prepared = yield* context.slot(prepare(repo, edits, context));

  if (prepared.pushed === null) return prepared.outcome;

  const runs = yield* watch(repo, prepared.pushed);

  yield* RunLog.info(
    runs === 0
      ? `${repo}: no CI ran on ${prepared.pushed.slice(0, 7)}`
      : `${repo}: CI passed`,
  );

  return prepared.outcome;
});

/** What preparing a consumer came to, with the commit pushed if there was one. */
interface Prepared {
  readonly outcome: Outcome;
  readonly pushed: string | null;
}

/** A dependency a consumer moves, from the version it was on. */
interface Moved {
  readonly from: string;
  readonly to: string;
}

const severity: Record<Regression.Verdict, number> = {
  skip: 0,
  unclear: 1,
  check: 2,
};

/**
 * A consumer's regression check, when it opts in and the release needs one:
 * its commands run, failing the consumer when one does, or with none the
 * update is held for an agent. The notes decide for the whole release and the
 * versions for each consumer. The decision model settles an unclear update
 * from its notes; without one, or when it can't, an unclear update is
 * checked. Returns whether the update is held.
 */
const regressionCheck = Effect.fnUntraced(function* (
  repo: string,
  moved: ReadonlyArray<Moved>,
  setting: Regression.Setting | undefined,
  context: BumpContext,
  options: {
    readonly cwd: string;
    readonly trusted: string;
    readonly mise: boolean;
  },
) {
  const commands = Regression.commands(
    setting,
    options.mise ? yield* miseTasks(options) : [],
  );

  if (commands === undefined) return false;

  const notes = yield* context.notes;

  const verdicts = yield* Effect.forEach(
    moved.length === 0 ? [undefined] : moved,
    (change) => {
      const ruled = {
        change,
        ...Regression.decide({ from: change?.from, to: change?.to, notes }),
      };

      // With no notes to read there's nothing for the model to go on
      return ruled.verdict !== "unclear" || notes === undefined
        ? Effect.succeed(ruled)
        : context.decide(change).pipe(
            Effect.map(
              Option.match({
                onNone: () => ruled,
                onSome: (decided) => ({ change, ...decided }),
              }),
            ),
          );
    },
  );

  const [decided] = verdicts.toSorted(
    (a, b) => severity[b.verdict] - severity[a.verdict],
  );

  const { release } = context;
  const against = `${release.repo} ${release.tag}`;

  if (decided === undefined || decided.verdict === "skip") {
    yield* RunLog.info(
      `${repo}: no regression check against ${against}, as ${decided?.why ?? "nothing moved"}`,
    );

    return false;
  }

  const why =
    decided.verdict === "unclear"
      ? `${decided.why}, which the rules can't settle`
      : decided.why;

  const links = {
    notes: release.url,
    compare:
      decided.change === undefined
        ? undefined
        : compareLink(release, decided.change.from, decided.change.to),
  };

  if (commands.length > 0) {
    yield* check(commands, options).pipe(
      Effect.tapError(() =>
        RunLog.warn(
          `${repo}: ${Regression.line({ against, why, outcome: `and ${commands.join(", ")} failed`, ...links })}`,
        ),
      ),
    );

    yield* RunLog.info(
      `${repo}: ran a regression check against ${against}, as ${why}: ${commands.join(", ")} passed`,
    );

    return false;
  }

  if (context.dryRun) {
    yield* RunLog.info(
      `${repo}: would hold for a regression check against ${against}, as ${why}`,
    );

    return true;
  }

  yield* run("git", ["reset", "--quiet", "--hard"], options);
  yield* run("git", ["clean", "--quiet", "-fd"], options);

  yield* RunLog.warn(
    `${repo}: ${Regression.line({ against, why, outcome: "so the update is held, unpushed, for an agent to apply and check", ...links })}`,
  );

  return true;
});

/** A consumer's edits applied, checked and pushed. */
const prepare = Effect.fnUntraced(function* (
  repo: string,
  edits: ReadonlyArray<Edit>,
  context: BumpContext,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const info = yield* Api.json(
    { endpoint: `repos/${repo}`, method: "GET" },
    RepositoryInfo,
  );

  if (info.archived || info.fork) {
    yield* RunLog.info(
      `${repo}: skipped, ${info.archived ? "archived" : "a fork"}`,
    );

    return { outcome: "skipped", pushed: null } satisfies Prepared;
  }

  const branch = info.default_branch;
  const { trusted } = context.worktrees;
  const directory = yield* context.worktrees.checkout(repo, branch);
  const options = { cwd: directory, trusted };

  const changed = new Set<string>();
  const manifests: Array<string> = [];
  const applied: Array<Edit> = [];
  const moved: Array<Moved> = [];

  for (const edit of edits) {
    const files = (yield* run(
      "git",
      ["ls-files", "--", ...pathspecs(edit)],
      options,
    ))
      .split("\n")
      .filter((file) => file !== "");

    let touched = false;

    for (const file of files) {
      const target = path.join(directory, file);
      const current = yield* fs.readFileString(target);
      const next = rewrite(edit, current);

      if (next === current) continue;

      yield* fs.writeFileString(target, next);
      changed.add(file);
      touched = true;

      if (Edit.$is("Dependency")(edit)) {
        manifests.push(file);

        for (const from of currentVersions(edit.name, current))
          if (from !== edit.version) moved.push({ from, to: edit.version });
      }
    }

    if (touched) applied.push(edit);
  }

  if (applied.length === 0) {
    yield* RunLog.info(`${repo}: already up to date`);

    return { outcome: "current", pushed: null } satisfies Prepared;
  }

  const mise = yield* usesMise(directory);

  for (const lockfile of yield* install(directory, manifests, {
    trusted,
    mise,
  })) {
    changed.add(lockfile);
  }

  const repoSettings = context.settings.bump?.repos?.[repo];

  // Pins only change workflows, which CI checks once they're pushed, and
  // nothing generated from the dependencies
  if (manifests.length > 0) {
    for (const file of yield* generate(repo, repoSettings?.generate, options))
      changed.add(file);

    const ran = yield* check(repoSettings?.checks, {
      ...options,
      mise,
    });

    yield* ran.length === 0
      ? RunLog.warn(
          `${repo}: has no check or build task, so nothing ran before the push`,
        )
      : RunLog.info(`${repo}: ${ran.join(", ")} passed`);

    // Pins only change workflows, so only a dependency's release can change
    // how the app looks or behaves
    if (
      yield* regressionCheck(repo, moved, repoSettings?.regression, context, {
        ...options,
        mise,
      })
    )
      return { outcome: "held", pushed: null } satisfies Prepared;
  }

  const message = `Update ${applied.map(describe).join(", ")}`;
  const files = [...changed].toSorted();

  if (context.dryRun) {
    yield* RunLog.info(
      `${repo}: would push "${message}" (${files.join(", ")})`,
    );

    return { outcome: "updated", pushed: null } satisfies Prepared;
  }

  yield* run("git", ["add", "--", ...files], options);

  const sha = yield* commitAndPush(message, branch, options);

  yield* pushed(repo, sha, message);

  yield* RunLog.info(
    `${repo}: pushed ${sha.slice(0, 7)} "${message}", watching CI`,
  );

  return { outcome: "updated", pushed: sha } satisfies Prepared;
});

/**
 * Bump every consumer of a release. Each starts once the packages it needs
 * are on npm, straight away for pins, and the local work runs four at a
 * time.
 */
export const bump = Effect.fnUntraced(function* (
  release: Domain.Release | null,
) {
  if (release === null) return yield* new NoRelease();

  const settings = yield* Settings.load();

  const dryRun = yield* Config.Boolean("UPKEEP_BUMP_DRY_RUN").pipe(
    Config.withDefault(false),
  );

  const { sha } = yield* Api.json(
    { endpoint: `repos/${release.repo}/commits/${release.tag}`, method: "GET" },
    Commit,
  );

  const repos = yield* trackedRepos(Catalogue.bump.id);
  const names = new Set(repos.map((repo) => repo.toLowerCase()));
  const tracked = (repo: string) => names.has(repo.toLowerCase());
  const found = yield* discover(release, sha, repos);

  const consumers = new Map(
    [...found.consumers].filter(([repo]) => tracked(repo)),
  );

  if (consumers.size === 0) {
    yield* summary(`Nothing uses ${release.repo}, so there's nothing to bump`);

    return skipped;
  }

  const slots = yield* Semaphore.make(4);
  const notes = yield* Effect.cached(readNotes(release));

  // Keyed by the version change, so consumers on the same version share an
  // answer, and the notes are the same for them all
  const decisions = yield* Cache.make({
    capacity: 64,
    lookup: Effect.fnUntraced(function* (key: string) {
      const [from = "", to = ""] = key.split("\u0000");
      const read = yield* notes;

      if (read === undefined) return Option.none<Regression.Decided>();

      return yield* Regression.ask(
        {
          package: release.repo,
          from,
          to,
          updateType: Regression.updateTypeOf(from, to) ?? "unknown",
          notes: Regression.trimNotes(read),
        },
        settings,
      );
    }),
  });

  const context: BumpContext = {
    release,
    notes,
    decide: (change) =>
      Cache.get(
        decisions,
        `${change?.from ?? "unknown"}\u0000${change?.to ?? release.tag}`,
      ),
    worktrees: yield* Worktrees.forRun("bump"),
    settings,
    dryRun,
    slot: (effect) => slots.withPermit(effect),
  };

  const failed: Array<string> = [];
  const updated: Array<string> = [];
  const held: Array<string> = [];

  const counts: Record<Outcome, number> = {
    updated: 0,
    current: 0,
    skipped: 0,
    held: 0,
  };

  yield* RunLog.info(
    `${dryRun ? "Dry run: bumping" : "Bumping"} ${release.repo} to ${release.tag} in ${consumers.size} repositories`,
  );

  yield* Effect.forEach(
    [...consumers].toSorted(([a], [b]) => a.localeCompare(b)),
    ([repo, edits]) =>
      ready(edits, found.onNpm, found.dependencies).pipe(
        Effect.flatMap((ready) =>
          ready.length === 0
            ? RunLog.info(
                `${repo}: skipped, what it uses never reached npm`,
              ).pipe(Effect.as<Outcome>("skipped"))
            : bumpRepository(repo, ready, context),
        ),
        Effect.tap((outcome) =>
          Effect.sync(() => {
            counts[outcome] += 1;

            if (outcome === "updated") updated.push(repo);

            if (outcome === "held") held.push(repo);
          }),
        ),
        Effect.catchCause((cause) =>
          RunLog.warn(`${repo}: ${reason(cause)}`).pipe(
            Effect.andThen(Effect.sync(() => failed.push(repo))),
          ),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  );

  yield* summary(
    [
      `${release.repo} ${release.tag}:`,
      `${dryRun ? "would update" : "updated"} ${listed(updated)},`,
      ...(held.length === 0
        ? []
        : [
            `${dryRun ? "would hold" : "held"} ${listed(held)} for a regression check,`,
          ]),
      `${counts.current} already up to date, ${counts.skipped} skipped,`,
      `${listed(failed)} failed`,
    ].join(" "),
  );

  // A run can't both fail and hand off, so a heal over the failures takes the
  // held updates with them, as the deps job does for a drift review
  if (failed.length > 0) {
    if (held.length > 0 && !dryRun)
      yield* RunLog.warn(
        `${listed(held)} held for a regression check, so they go to the heal with the failures`,
      );

    return yield* new ConsumersFailed({
      action: "bump",
      repos: [...failed, ...(dryRun ? [] : held)].toSorted(),
    });
  }

  if (held.length > 0 && !dryRun)
    return HandedOff.make({ repos: held.toSorted() });
}, Effect.scoped);
