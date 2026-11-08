/**
 * The drift job: keep each repository reviewed against the releases of the
 * tools it wraps, configures or forks, recorded in the `tooling.yml` at its
 * root. A reimplementation of tooling-drift, pushing to the default branch
 * rather than opening pull requests.
 *
 * For each tool whose release moved, its update command runs at the new tag
 * and the tag is recorded as reviewed. When only the pins moved, the change
 * is pushed and its CI watched. When the update changed anything else, or
 * the tool has no update command, the release needs a review: nothing is
 * pushed for it, and the repository fails with what to review, which the
 * heal hands to an agent.
 */
import { Api, Search } from "@timmo001/effect-gh";
import { Catalogue, EventJobs } from "@upkeep/api";
import { Config, Effect, FileSystem, Path, Schedule, Schema } from "effect";
import { Yaml } from "effect/encoding";
import { reason } from "../Failure";
import * as GitHubApp from "../GitHubApp";
import { listed, pushed, summary, trackedFor } from "../Reporter";
import * as RunLog from "../RunLog";
import { ConsumersFailed, HandedOff, skipped } from "../Worker";
import { checkout, run, watch } from "./bump";

/**
 * The file at a repository root that records its reviewed tool releases.
 * Shared with the server, which starts `drift` when a push changes it.
 */
export const toolingFile = EventJobs.toolingFile;

/** One tool the repository depends on, with the release last reviewed. */
const Tool = Schema.Struct({
  /** GitHub repository whose releases are tracked, as `owner/name`. */
  repo: Schema.String,
  /** Release tag last reviewed. */
  reviewed: Schema.String,
  /** Follow the newest tag matching this pattern, not the latest release. */
  tags: Schema.optionalKey(Schema.String),
  /** Follow prereleases too, read from the repository's tags. */
  prereleases: Schema.optionalKey(Schema.Boolean),
  /** Command run with the tag to refresh what the repository derives. */
  update: Schema.optionalKey(Schema.String),
  /** Files a pin move touches; any other change needs a review. */
  pins: Schema.optionalKey(Schema.Array(Schema.String)),
  /** One line on what to review. */
  review: Schema.optionalKey(Schema.String),
});

export type Tool = typeof Tool.Type;

/** Fields tooling-drift's pull requests used are allowed and ignored. */
const ToolingFile = Schema.Struct({
  tools: Schema.Array(Tool),
});

export class DriftError extends Schema.TaggedError<DriftError>()("DriftError", {
  message: Schema.String,
}) {}

const LatestRelease = Schema.Struct({ tag_name: Schema.String });

const RepositoryInfo = Schema.Struct({
  archived: Schema.Boolean,
  fork: Schema.Boolean,
  default_branch: Schema.String,
});

const repositoryPattern = /^[\w.-]+\/[\w.-]+$/;

const sameRepository = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

/** Decode tooling.yml, rejecting malformed or repeated repositories. */
export const decode = Effect.fnUntraced(function* (text: string) {
  const value = yield* Effect.try({
    try: () => Yaml.parse(text),
    catch: (cause) =>
      new DriftError({
        message: `${toolingFile} isn't valid YAML: ${String(cause)}`,
      }),
  });

  const file = yield* Schema.decodeUnknownEffect(ToolingFile)(value).pipe(
    Effect.mapError(
      (cause) =>
        new DriftError({
          message: `${toolingFile} doesn't match the expected shape: ${String(cause)}`,
        }),
    ),
  );

  const seen = new Set<string>();

  for (const tool of file.tools) {
    if (!repositoryPattern.test(tool.repo))
      return yield* new DriftError({
        message: `${toolingFile}: ${JSON.stringify(tool.repo)} isn't an owner/name repository`,
      });

    if (tool.tags !== undefined) {
      try {
        new RegExp(tool.tags);
      } catch {
        return yield* new DriftError({
          message: `${toolingFile}: ${tool.repo} tags ${JSON.stringify(tool.tags)} isn't a valid pattern`,
        });
      }
    }

    if (seen.has(tool.repo.toLowerCase()))
      return yield* new DriftError({
        message: `${toolingFile}: ${tool.repo} is listed more than once`,
      });

    seen.add(tool.repo.toLowerCase());
  }

  return file;
});

/** Quote tags YAML would read as something else, such as 20261028.0. */
const yamlTag = (tag: string) => {
  try {
    if (Yaml.parse(tag) === tag) return tag;
  } catch {
    // Not a plain scalar, so it needs quoting
  }

  return JSON.stringify(tag);
};

/**
 * Rewrite one tool's `reviewed` line and leave everything else as written,
 * comments included. Returns the text unchanged when the tool is absent.
 */
export const recordReviewed = (text: string, repo: string, tag: string) => {
  let current: string | undefined;

  return text
    .split("\n")
    .map((line) => {
      const start = /^\s*-\s*repo:\s*(?<repo>.*?)\s*$/.exec(line)?.groups?.repo;

      if (start !== undefined) {
        current = start.replace(/^"|"$/g, "");

        return line;
      }

      const prefix = /^(?<prefix>\s+reviewed:\s*).*$/.exec(line)?.groups
        ?.prefix;

      return prefix !== undefined &&
        current !== undefined &&
        sameRepository(current, repo)
        ? `${prefix}${yamlTag(tag)}`
        : line;
    })
    .join("\n");
};

/** `x.y.z`, or `x.y` for tools such as Home Assistant's frontend. */
const stableVersion = /(\d+)\.(\d+)(?:\.(\d+))?$/;

/** A version with an optional prerelease after it, such as `-rc.2`. */
const anyVersion =
  /(\d+)\.(\d+)(?:\.(\d+))?(?:-?([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

interface Version {
  readonly tag: string;
  readonly parts: ReadonlyArray<number>;
  readonly prerelease: string | undefined;
}

const compareVersions = (a: Version, b: Version) => {
  // A missing part counts as 0, so `1.2` sorts with `1.2.0`
  const parts = Array.from(
    { length: Math.max(a.parts.length, b.parts.length) },
    (_, index) => (a.parts[index] ?? 0) - (b.parts[index] ?? 0),
  ).reduce((order, part) => order || part, 0);

  if (parts !== 0) return parts;

  // A prerelease comes before its stable version
  if (a.prerelease === undefined || b.prerelease === undefined)
    return (
      Number(a.prerelease === undefined) - Number(b.prerelease === undefined)
    );

  // Natural order, so rc10 follows rc9
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
};

/**
 * The highest version among the tags matching a pattern. Prereleases are
 * skipped unless included, when one is newer than the stable version before
 * it and older than its own.
 */
export const newestTag = (
  tags: ReadonlyArray<string>,
  pattern: string,
  prereleases = false,
) => {
  const matcher = new RegExp(pattern);

  const versions = tags.flatMap((tag): Array<Version> => {
    if (!matcher.test(tag)) return [];

    const version = (prereleases ? anyVersion : stableVersion).exec(tag);

    return version
      ? [
          {
            tag,
            parts: version
              .slice(1, 4)
              .filter((part) => part !== undefined)
              .map(Number),
            prerelease: version[4],
          },
        ]
      : [];
  });

  return versions.reduce<Version | undefined>(
    (newest, version) =>
      newest && compareVersions(newest, version) >= 0 ? newest : version,
    undefined,
  )?.tag;
};

/** Files an update changed that aren't the tool's pins. */
export const derivedFiles = (tool: Tool, changed: ReadonlyArray<string>) => {
  const pins = new Set(tool.pins ?? [toolingFile]);

  return changed.filter((file) => !pins.has(file));
};

/** What a person or agent needs to review a release that moved. */
export const needsReview = (
  tool: Tool,
  tag: string,
  derived: ReadonlyArray<string>,
) =>
  [
    `${tool.repo} moved from ${tool.reviewed} to ${tag} and needs a review`,
    derived.length > 0
      ? `: its update changed ${derived.join(", ")}.`
      : tool.update === undefined
        ? ": the repository depends on its behaviour."
        : ".",
    tool.review === undefined ? "" : ` ${tool.review}`,
    ` Release notes: https://github.com/${tool.repo}/releases/tag/${tag}, compare: https://github.com/${tool.repo}/compare/${tool.reviewed}...${tag}.`,
    ` Once it's reviewed, ${tool.update === undefined ? "" : `run \`${tool.update} ${tag}\`, `}set its \`reviewed\` to ${tag} in ${toolingFile}, and push to the default branch.`,
  ].join("");

/**
 * What an agent needs to review a repository as a whole against a tool's
 * current release: everything it's behind on, not only what changed since
 * the release last reviewed.
 */
export const needsFullReview = (tool: Tool, tag: string) =>
  [
    `review the whole repository against ${tool.repo} ${tag}, ${tag === tool.reviewed ? "not only the changes its last review covered" : `not only what changed since ${tool.reviewed}`}:`,
    " features, commands, flags and config options the tool has that the repository doesn't cover yet, and snapshots or derived files that no longer match.",
    tool.review === undefined ? "" : ` ${tool.review}`,
    ` Release: https://github.com/${tool.repo}/releases/tag/${tag}.`,
    ` Add what's missing and push it to the default branch${tag === tool.reviewed ? "" : `, then set its \`reviewed\` to ${tag} in ${toolingFile}`}. If nothing is missing, say so.`,
  ].join("");

export const cacheRoot = Config.String("XDG_CACHE_HOME").pipe(
  Config.orElse(() =>
    Config.String("HOME").pipe(Config.map((home) => `${home}/.cache`)),
  ),
  Config.map((root) => `${root}/upkeep/drift`),
);

interface Options {
  readonly cwd: string;
  readonly trusted: string;
}

/** The latest release of a tool, or its newest matching tag. */
const latest = Effect.fnUntraced(function* (tool: Tool, options: Options) {
  if (tool.tags === undefined && tool.prereleases !== true) {
    const release = yield* Api.json(
      { endpoint: `repos/${tool.repo}/releases/latest`, method: "GET" },
      LatestRelease,
    );

    return release.tag_name;
  }

  const tags = (yield* run(
    "git",
    ["ls-remote", "--tags", "--refs", `https://github.com/${tool.repo}.git`],
    options,
  ))
    .split("\n")
    .flatMap((line) => line.split("\trefs/tags/").slice(1));

  const tag = newestTag(tags, tool.tags ?? "", tool.prereleases === true);

  if (tag === undefined)
    return yield* new DriftError({
      message: `${tool.repo} has no tag matching ${tool.tags ?? "a version"}`,
    });

  return tag;
});

/** Every repository of the signed-in account with a tooling.yml. */
const repositories = Effect.fnUntraced(function* () {
  const login = yield* GitHubApp.login;

  const results = yield* Search.code({
    query: "reviewed",
    owner: login,
    filename: toolingFile,
    limit: 1000,
  }).pipe(
    Effect.retry({ schedule: Schedule.exponential("15 seconds"), times: 4 }),
  );

  return [
    ...new Set(
      results
        .filter((result) => result.path === toolingFile)
        .map((result) => result.repository.nameWithOwner),
    ),
  ].toSorted();
});

type Outcome = "updated" | "current" | "review" | "skipped";

interface DriftContext {
  readonly root: string;
  readonly dryRun: boolean;
}

/** Check one repository's tools, pushing the pin moves that need no review. */
export const driftRepository = Effect.fnUntraced(function* (
  repo: string,
  context: DriftContext,
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
  const file = path.join(directory, toolingFile);

  yield* checkout(repo, branch, directory, context.root);

  const { tools } = yield* decode(yield* fs.readFileString(file));
  const problems: Array<string> = [];
  const reviews: Array<string> = [];
  const moved: Array<string> = [];

  for (const tool of tools) {
    const tag = yield* latest(tool, options).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          problems.push(
            `couldn't read ${tool.repo}'s latest release: ${reason(cause)}`,
          );
        }),
      ),
    );

    if (tag === undefined || tag === tool.reviewed) continue;

    if (tool.update === undefined) {
      reviews.push(needsReview(tool, tag, []));

      continue;
    }

    yield* run("sh", ["-c", `${tool.update} "$1"`, "sh", tag], options);
    yield* fs.writeFileString(
      file,
      recordReviewed(yield* fs.readFileString(file), tool.repo, tag),
    );

    const changed = (yield* run(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      options,
    ))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.slice(3));

    const derived = derivedFiles(tool, changed);

    if (derived.length > 0) {
      reviews.push(needsReview(tool, tag, derived));

      yield* run("git", ["reset", "--quiet", "--hard"], options);
      yield* run("git", ["clean", "--quiet", "-fd"], options);

      continue;
    }

    if (changed.length === 0) continue;

    yield* run("git", ["add", "--", ...changed], options);
    yield* run(
      "git",
      ["commit", "--quiet", "-m", `Update ${tool.repo} to ${tag}`],
      options,
    );

    moved.push(`${tool.repo} to ${tag}`);
  }

  for (const problem of [...problems, ...reviews])
    yield* RunLog.warn(`${repo}: ${problem}`);

  if (moved.length > 0) {
    if (context.dryRun) {
      yield* RunLog.info(`${repo}: would push ${moved.join(", ")}`);
    } else {
      const push = run(
        "git",
        ["push", "--quiet", "origin", `HEAD:${branch}`],
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

      const sha = (yield* run("git", ["rev-parse", "HEAD"], options)).trim();

      // Its commits are on top, one per tool, even after a rebase.
      const log = yield* run(
        "git",
        ["log", `-${moved.length}`, "--reverse", "--format=%H%x09%s"],
        options,
      );

      for (const line of log.trim().split("\n")) {
        const [commit = "", subject = ""] = line.split("\t");

        yield* pushed(repo, commit, subject);
      }

      yield* RunLog.info(
        `${repo}: pushed ${sha.slice(0, 7)}, ${moved.join(", ")}, watching CI`,
      );

      const runs = yield* watch(repo, sha);

      yield* RunLog.info(
        runs === 0
          ? `${repo}: no CI ran on ${sha.slice(0, 7)}`
          : `${repo}: CI passed`,
      );
    }
  }

  if (problems.length > 0)
    return yield* new DriftError({
      message: `${problems.length + reviews.length} ${problems.length + reviews.length === 1 ? "tool needs" : "tools need"} attention`,
    });

  // Releases to review aren't a failure: they're handed to an agent
  if (reviews.length > 0) return "review" satisfies Outcome;

  return moved.length > 0 ? "updated" : ("current" satisfies Outcome);
});

/** Check every repository with a tooling.yml, two at a time. */
export const drift = Effect.fnUntraced(function* () {
  const root = yield* cacheRoot;

  const dryRun = yield* Config.Boolean("UPKEEP_DRIFT_DRY_RUN").pipe(
    Config.withDefault(false),
  );

  const tracked = yield* trackedFor(Catalogue.drift.id);
  const repos = (yield* repositories()).filter(tracked);
  const failed: Array<string> = [];
  const reviewing: Array<string> = [];
  const updated: Array<string> = [];

  const counts: Record<Outcome, number> = {
    updated: 0,
    current: 0,
    review: 0,
    skipped: 0,
  };

  yield* RunLog.info(
    `${dryRun ? "Dry run: checking" : "Checking"} tool drift in ${repos.length} repositories`,
  );

  yield* Effect.forEach(
    repos,
    (repo) =>
      driftRepository(repo, { root, dryRun }).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            counts[outcome] += 1;

            if (outcome === "updated") updated.push(repo);

            if (outcome === "review") reviewing.push(repo);
          }),
        ),
        Effect.catchCause((cause) =>
          RunLog.warn(`${repo}: ${reason(cause)}`).pipe(
            Effect.andThen(Effect.sync(() => failed.push(repo))),
          ),
        ),
      ),
    { concurrency: 2, discard: true },
  );

  yield* summary(
    `${dryRun ? "Would update" : "Updated"} ${listed(updated)}, ${counts.current} reviewed, ${counts.skipped} skipped, ${listed(reviewing)} to review, ${listed(failed)} need attention`,
  );

  // A heal over the failures takes the reviews with it, so one agent
  // session sees them all
  if (failed.length > 0 && !dryRun)
    return yield* new ConsumersFailed({
      action: "drift",
      repos: [...failed, ...reviewing].toSorted(),
    });

  if (reviewing.length > 0 && !dryRun)
    return HandedOff.make({ repos: reviewing.toSorted() });

  // Nothing moved, as after drift's own push comes back as an event
  if (updated.length === 0) return skipped;
});

/**
 * List what an agent should review one repository for: each tool in its
 * tooling.yml against its current release, as a whole. Returns `review` when
 * it listed any, so the run hands it to an agent, or `skipped` for an
 * archived or forked repository or one with no tools.
 */
export const reviewRepository = Effect.fnUntraced(function* (
  repo: string,
  root: string,
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

  const directory = path.join(root, repo);
  const options = { cwd: directory, trusted: root };

  yield* checkout(repo, info.default_branch, directory, root);

  const { tools } = yield* decode(
    yield* fs.readFileString(path.join(directory, toolingFile)),
  );

  if (tools.length === 0) return "skipped" satisfies Outcome;

  for (const tool of tools) {
    const tag = yield* latest(tool, options).pipe(
      Effect.catchCause((cause) =>
        RunLog.warn(
          `${repo}: couldn't read ${tool.repo}'s latest release, so review against ${tool.reviewed}: ${reason(cause)}`,
        ).pipe(Effect.as(tool.reviewed)),
      ),
    );

    yield* RunLog.warn(`${repo}: ${needsFullReview(tool, tag)}`);
  }

  yield* RunLog.info(
    `${repo}: ${tools.length} ${tools.length === 1 ? "tool" : "tools"} to review as a whole`,
  );

  return "review" satisfies Outcome;
});

/**
 * The drift review: on request, hand each repository tracked for drift to an
 * agent, through a heal, to review as a whole against the current release of
 * every tool it lists. It has no schedule, so its findings never repeat on
 * their own; narrow it to one repository with `--repo`.
 */
export const driftReview = Effect.fnUntraced(function* () {
  const root = yield* cacheRoot;
  const tracked = yield* trackedFor(Catalogue.drift.id);
  const repos = (yield* repositories()).filter(tracked);
  const failed: Array<string> = [];
  const reviewing: Array<string> = [];

  yield* RunLog.info(`Reviewing ${repos.length} repositories as a whole`);

  yield* Effect.forEach(
    repos,
    (repo) =>
      reviewRepository(repo, root).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (outcome === "review") reviewing.push(repo);
          }),
        ),
        Effect.catchCause((cause) =>
          RunLog.warn(`${repo}: ${reason(cause)}`).pipe(
            Effect.andThen(Effect.sync(() => failed.push(repo))),
          ),
        ),
      ),
    { concurrency: 2, discard: true },
  );

  yield* summary(
    [
      reviewing.length === 0
        ? "Nothing to review"
        : `Handed ${listed(reviewing)} to an agent to review as a whole`,
      ...(failed.length === 0 ? [] : [`${listed(failed)} failed`]),
    ].join(", "),
  );

  // A heal over the failures takes the reviews with it, so one agent
  // session sees them all
  if (failed.length > 0)
    return yield* new ConsumersFailed({
      action: "review",
      repos: [...failed, ...reviewing].toSorted(),
    });

  if (reviewing.length > 0)
    return HandedOff.make({ repos: reviewing.toSorted() });

  // A lone literal return would widen to string, which no handler returns
  const nothing: typeof skipped = skipped;

  return nothing;
});
