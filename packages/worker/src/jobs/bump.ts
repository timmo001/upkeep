/**
 * The bump job: roll a release out to the repositories that use it. Consumers
 * are found through code search, from workflow pins of the released
 * repository and from `package.json` dependencies on the packages it
 * publishes. Each one is cloned, edited, checked and pushed straight to its
 * default branch, then its CI is watched. A consumer that fails is logged and
 * the rest carry on; the run fails at the end, naming them.
 */
import { Api, Repository, Search, Workflow } from "@timmo001/effect-gh";
import { Catalogue, type Domain } from "@upkeep/api";
import {
  Config,
  Data,
  Effect,
  FileSystem,
  Path,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { reason } from "../Failure";
import * as RateLimits from "../RateLimits";
import * as RunLog from "../RunLog";
import { listed, pushed, summary, trackedFor } from "../Reporter";
import * as Settings from "../settings";
import { ConsumersFailed, skipped } from "../Worker";

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

class CommandFailed extends Schema.TaggedError<CommandFailed>()(
  "CommandFailed",
  {
    command: Schema.String,
    exitCode: Schema.Int,
    output: Schema.String,
  },
) {
  override get message() {
    const tail = this.output.trim().split("\n").slice(-20).join("\n");

    return `${this.command} exited with ${this.exitCode}${tail === "" ? "" : `\n${tail}`}`;
  }
}

class CiFailed extends Schema.TaggedError<CiFailed>()("CiFailed", {
  runs: Schema.Array(Schema.String),
}) {
  override get message() {
    return `CI failed after the push:\n${this.runs.join("\n")}`;
  }
}

class CiTimedOut extends Schema.TaggedError<CiTimedOut>()("CiTimedOut", {
  sha: Schema.String,
}) {
  override get message() {
    return `CI on ${this.sha.slice(0, 7)} was still going after 30 minutes`;
  }
}

class NoRelease extends Schema.TaggedError<NoRelease>()("NoRelease", {}) {
  override get message() {
    return "The bump job runs for a release; give one with --release";
  }
}

const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

/**
 * How GitHub fails for a moment: SSH refusing a key it accepts a minute
 * later, a remote that can't be read, a 5xx or a lazy fetch of a missing
 * object. Worth retrying rather than failing the repository over.
 */
const transient =
  /Permission denied \(publickey\)|Could not read from remote repository|Internal Server Error|fatal error in commit_refs|could not fetch [0-9a-f]+ from promisor remote|Connection (?:reset|timed out|closed)|returned error: 5\d\d/;

/**
 * Run a command to the end and return its stdout, failing with its output on
 * a non-zero exit. Clones live under the cache root, which mise is told to
 * trust, and nothing may prompt, so it gets no stdin. A git command that fails on a GitHub blip
 * is tried again, up to four more times over about two minutes.
 */
export const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly trusted: string },
) =>
  runOnce(command, args, options).pipe(
    Effect.retry({
      while: (error) =>
        error instanceof CommandFailed &&
        error.command.startsWith("git ") &&
        transient.test(error.output),
      schedule: Schedule.exponential("5 seconds"),
      times: 4,
    }),
  );

const runOnce = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly trusted: string },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const label = [command, ...args].join(" ");

  const [stdout, stderr, exitCode] = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          cwd: options.cwd,
          // Nothing may prompt, and a command that reads a piped stdin, such
          // as `opencode run`, would wait on it forever
          stdin: "ignore",
          extendEnv: true,
          env: {
            MISE_TRUSTED_CONFIG_PATHS: options.trusted,
            MISE_YES: "1",
            GIT_TERMINAL_PROMPT: "0",
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

  if (Number(exitCode) !== 0) {
    return yield* new CommandFailed({
      command: label,
      exitCode: Number(exitCode),
      output: `${stderr}\n${stdout}`,
    });
  }

  return stdout;
});

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
});

const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Manifest),
);

/** Code search allows a handful of requests a minute, so back off on a limit. */
const search = (input: Search.CodeInput) =>
  Search.code({ ...input, limit: 1000 }).pipe(
    Effect.retry({ schedule: Schedule.exponential("15 seconds"), times: 4 }),
    Effect.map((results) => [
      ...new Set(results.map((result) => result.repository.nameWithOwner)),
    ]),
  );

/** The npm packages the release publishes, from its `package.json` files. */
const packages = Effect.fnUntraced(function* (release: Domain.Release) {
  const { tree } = yield* Api.json(
    {
      endpoint: `repos/${release.repo}/git/trees/${release.tag}?recursive=1`,
      method: "GET",
    },
    Tree,
  );

  const found: Array<{ readonly name: string; readonly version: string }> = [];

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
      found.push({ name: manifest.name, version: manifest.version });
    }
  }

  return found;
});

/**
 * Wait for a version to reach npm, since the release usually starts the
 * publish. Gives up after 20 minutes.
 */
const published = Effect.fnUntraced(function* (name: string, version: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = yield* HttpClient.get(
      `https://registry.npmjs.org/${name}/${version}`,
    );

    if (response.status === 200) return true;

    if (attempt === 0) {
      yield* RunLog.info(`Waiting for ${name}@${version} to reach npm`);
    }

    yield* Effect.sleep("1 minute");
  }

  return false;
});

/** Every consumer of the release and what changes in each. */
const discover = Effect.fnUntraced(function* (
  release: Domain.Release,
  sha: string,
) {
  const [owner = ""] = release.repo.split("/");
  const consumers = new Map<string, Array<Edit>>();

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

  for (const { name, version } of yield* packages(release)) {
    if (!(yield* published(name, version))) {
      yield* RunLog.warn(
        `${name}@${version} isn't on npm after 20 minutes, so its consumers are left`,
      );

      continue;
    }

    // gh escapes quotes inside a quoted term, and code search can then report
    // matches but return no items, so the name goes in bare
    add(
      yield* search({ query: name, owner, filename: "package.json" }),
      Edit.Dependency({ name, version }),
    );
  }

  return consumers;
});

export const cacheRoot = Config.String("XDG_CACHE_HOME").pipe(
  Config.orElse(() =>
    Config.String("HOME").pipe(Config.map((home) => `${home}/.cache`)),
  ),
  Config.map((root) => `${root}/upkeep/bump`),
);

/**
 * A clean checkout of the default branch, reusing the last one, with its
 * submodules when it has any.
 */
export const checkout = Effect.fnUntraced(function* (
  repo: string,
  branch: string,
  directory: string,
  trusted: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const options = { cwd: directory, trusted };

  if (yield* fs.exists(directory)) {
    yield* run("git", ["fetch", "--quiet", "origin", branch], options);
    yield* run(
      "git",
      ["checkout", "--quiet", "--force", "-B", branch, `origin/${branch}`],
      options,
    );
    yield* run("git", ["clean", "--quiet", "-fdx"], options);
  } else
    yield* Repository.clone({
      repository: repo,
      directory,
      gitArgs: ["--quiet", "--filter=blob:none"],
    });

  if (yield* fs.exists(path.join(directory, ".gitmodules")))
    yield* run(
      "git",
      ["submodule", "update", "--quiet", "--init", "--recursive", "--force"],
      options,
    );
});

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
const tool = (
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

/** The repository's own mise tasks, leaving out global ones. */
const miseTasks = (options: {
  readonly cwd: string;
  readonly trusted: string;
}) =>
  run("mise", ["tasks", "ls", "--no-global", "--name-only"], options).pipe(
    Effect.map((output) => output.split("\n").map((line) => line.trim())),
  );

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
 * Returns how many ran; none have started after two minutes means none.
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
  let sha = commit;
  let since = 0;

  for (let poll = 0; poll < 60; poll++) {
    yield* Effect.sleep("30 seconds");

    const runs = yield* RateLimits.waitOut(
      Workflow.list({ repo, commit: sha, limit: 50 }),
      `${repo}: watching CI`,
    );

    if (runs.length === 0) {
      if (poll - since >= 3) return 0;

      continue;
    }

    if (runs.some((item) => item.status !== "completed")) continue;

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
      since = poll + 1;

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

  return yield* new CiTimedOut({ sha });
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

  yield* run("git", ["commit", "--quiet", "-m", message], options);

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

type Outcome = "updated" | "current" | "skipped";

interface BumpContext {
  /** Where clones live, which mise is told to trust. */
  readonly root: string;
  readonly settings: Settings.Settings;
  readonly dryRun: boolean;
}

/** Apply a consumer's edits, check, push and watch its CI. */
const bumpRepository = Effect.fnUntraced(function* (
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

    return "skipped" satisfies Outcome;
  }

  const branch = info.default_branch;
  const directory = path.join(context.root, repo);
  const options = { cwd: directory, trusted: context.root };

  yield* checkout(repo, branch, directory, context.root);

  const changed = new Set<string>();
  const manifests: Array<string> = [];
  const applied: Array<Edit> = [];

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

      if (Edit.$is("Dependency")(edit)) manifests.push(file);
    }

    if (touched) applied.push(edit);
  }

  if (applied.length === 0) {
    yield* RunLog.info(`${repo}: already up to date`);

    return "current" satisfies Outcome;
  }

  const mise = yield* usesMise(directory);

  for (const lockfile of yield* install(directory, manifests, {
    trusted: context.root,
    mise,
  })) {
    changed.add(lockfile);
  }

  // Pins only change workflows, which CI checks once they're pushed
  if (manifests.length > 0) {
    const ran = yield* check(context.settings.bump?.repos?.[repo]?.checks, {
      ...options,
      mise,
    });

    yield* ran.length === 0
      ? RunLog.warn(
          `${repo}: has no check or build task, so nothing ran before the push`,
        )
      : RunLog.info(`${repo}: ${ran.join(", ")} passed`);
  }

  const message = `Update ${applied.map(describe).join(", ")}`;
  const files = [...changed].toSorted();

  if (context.dryRun) {
    yield* RunLog.info(
      `${repo}: would push "${message}" (${files.join(", ")})`,
    );

    return "updated" satisfies Outcome;
  }

  yield* run("git", ["add", "--", ...files], options);

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

  return "updated" satisfies Outcome;
});

/** Bump every consumer of a release, four at a time. */
export const bump = Effect.fnUntraced(function* (
  release: Domain.Release | null,
) {
  if (release === null) return yield* new NoRelease();

  const settings = yield* Settings.load();
  const root = yield* cacheRoot;

  const dryRun = yield* Config.Boolean("UPKEEP_BUMP_DRY_RUN").pipe(
    Config.withDefault(false),
  );

  const { sha } = yield* Api.json(
    { endpoint: `repos/${release.repo}/commits/${release.tag}`, method: "GET" },
    Commit,
  );

  const tracked = yield* trackedFor(Catalogue.bump.id);

  const consumers = new Map(
    [...(yield* discover(release, sha))].filter(([repo]) => tracked(repo)),
  );

  if (consumers.size === 0) {
    yield* summary(`Nothing uses ${release.repo}, so there's nothing to bump`);

    return skipped;
  }

  const failed: Array<string> = [];
  const updated: Array<string> = [];

  const counts: Record<Outcome, number> = {
    updated: 0,
    current: 0,
    skipped: 0,
  };

  yield* RunLog.info(
    `${dryRun ? "Dry run: bumping" : "Bumping"} ${release.repo} to ${release.tag} in ${consumers.size} repositories`,
  );

  yield* Effect.forEach(
    [...consumers].toSorted(([a], [b]) => a.localeCompare(b)),
    ([repo, edits]) =>
      bumpRepository(repo, edits, { root, settings, dryRun }).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            counts[outcome] += 1;

            if (outcome === "updated") updated.push(repo);
          }),
        ),
        Effect.catchCause((cause) =>
          RunLog.warn(`${repo}: ${reason(cause)}`).pipe(
            Effect.andThen(Effect.sync(() => failed.push(repo))),
          ),
        ),
      ),
    { concurrency: 4, discard: true },
  );

  yield* summary(
    [
      `${release.repo} ${release.tag}:`,
      `${dryRun ? "would update" : "updated"} ${listed(updated)},`,
      `${counts.current} already up to date, ${counts.skipped} skipped,`,
      `${listed(failed)} failed`,
    ].join(" "),
  );

  if (failed.length > 0)
    return yield* new ConsumersFailed({
      action: "bump",
      repos: failed.toSorted(),
    });
});
