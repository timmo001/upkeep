/**
 * The unreleased job: for each repository tracked for it, compare its
 * watched branch with its last stable release, classify every net change by
 * its policy and settings, and send the comparison to the server for the
 * Releases page, where you review it and publish. A repository that can't be
 * read is sent with why, so the page keeps its last comparison as stale.
 * Each one is read from a bare clone in the cache, without a checkout.
 */
import { Api, Repository } from "@timmo001/effect-gh";
import { Catalogue, type Domain } from "@upkeep/api";
import { highestImpact } from "@upkeep/api/releases";
import {
  Clock,
  Config,
  Effect,
  FileSystem,
  Path,
  Result,
  Schema,
} from "effect";
import { collect, git, ReleaseError, why } from "../releases/Changes";
import {
  classify,
  policyId,
  settingsOf,
  type Settings,
} from "../releases/Policy";
import { latestStable, readRecipe } from "../releases/Publish";
import { Reporter, summary } from "../Reporter";
import * as RunLog from "../RunLog";
import * as SettingsFile from "../settings";
import { skipped } from "../Worker";

/** Where the job keeps its clones and what it read of submodules' upstreams. */
export const cacheRoot = Config.String("XDG_CACHE_HOME").pipe(
  Config.orElse(() =>
    Config.String("HOME").pipe(Config.map((home) => `${home}/.cache`)),
  ),
  Config.map((root) => `${root}/upkeep/unreleased`),
);

/** A repository's settings, matched without regard to case. */
export const settingsFor = (
  settings: SettingsFile.Settings,
  repo: string,
): SettingsFile.ReleaseRepo | undefined =>
  Object.entries(settings.releases?.repos ?? {}).find(
    ([name]) => name.toLowerCase() === repo.toLowerCase(),
  )?.[1];

/** A bare clone of the repository in the cache, made the first time. */
export const bareClone = Effect.fnUntraced(function* (
  repo: string,
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(root, "clones", `${repo}.git`);

  if (!(yield* fs.exists(directory))) {
    yield* RunLog.info(`${repo}: cloning into ${directory}`);
    yield* fs.makeDirectory(path.dirname(directory), { recursive: true });
    yield* Repository.clone({
      repository: repo,
      directory,
      gitArgs: ["--quiet", "--bare"],
    });
  }

  return directory;
});

const RepositoryInfo = Schema.Struct({ default_branch: Schema.String });

const UpstreamTags = Schema.Array(Schema.Struct({ name: Schema.String }));

const UpstreamManifest = Schema.fromJsonString(
  Schema.Struct({ version: Schema.String }),
);

const plain = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Plain SemVer tags, newest first. */
const newestFirst = (a: string, b: string) => {
  const left = a.replace(/^v/, "").split(".").map(Number);
  const right = b.replace(/^v/, "").split(".").map(Number);

  for (let index = 0; index < 3; index++) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);

    if (difference !== 0) return difference;
  }

  return 0;
};

/** Whether `ancestor` is in `head`'s history. */
const isAncestor = (clone: string, ancestor: string, head: string) =>
  git(clone, ["merge-base", "--is-ancestor", ancestor, head]).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

/**
 * A fork's upstream version: the newest plain SemVer tag of its upstream in
 * the branch's history, or for `fork-base-js`, the version in the upstream's
 * `package.json` where the branch last merged it.
 */
const upstreamBase = Effect.fnUntraced(function* (
  clone: string,
  head: string,
  settings: Settings,
) {
  const fork = settings.fork;

  if (fork === null)
    return yield* new ReleaseError({
      message: "Fork release settings are missing",
    });

  const url = `https://github.com/${fork.upstream}.git`;

  const fetch = (refspec: string) =>
    git(clone, [
      "fetch",
      "--quiet",
      "--no-write-fetch-head",
      "--no-tags",
      "--no-recurse-submodules",
      url,
      refspec,
    ]);

  if (settings.versioning === "fork-base-js") {
    yield* fetch("+HEAD:refs/upkeep/upstream");

    const base = (yield* git(clone, [
      "merge-base",
      "refs/upkeep/upstream^{commit}",
      head,
    ])).trim();

    const manifest = yield* git(clone, ["show", `${base}:package.json`]);

    return (yield* Schema.decodeUnknownEffect(UpstreamManifest)(manifest).pipe(
      Effect.mapError((error) => new ReleaseError({ message: why(error) })),
    )).version;
  }

  const pages = yield* Api.pages(
    {
      endpoint: `repos/${fork.upstream}/tags`,
      method: "GET",
      query: { per_page: 100 },
    },
    UpstreamTags,
  ).pipe(Effect.mapError((error) => new ReleaseError({ message: why(error) })));

  const tags = pages
    .flat()
    .map(({ name }) => name)
    .filter((name) => plain.test(name))
    .toSorted(newestFirst);

  for (const tag of tags) {
    yield* fetch(`+refs/tags/${tag}:refs/upkeep/upstream`);

    if (yield* isAncestor(clone, "refs/upkeep/upstream^{commit}", head))
      return tag.replace(/^v/, "");
  }

  return yield* new ReleaseError({
    message: `No plain SemVer tag of ${fork.upstream} is in the branch's history`,
  });
});

/** Compare one repository's branch with its last stable release. */
const compare = Effect.fnUntraced(function* (
  repo: string,
  branch: string,
  config: SettingsFile.ReleaseRepo | undefined,
  root: string,
) {
  const path = yield* Path.Path;
  const settings = settingsOf(config);
  const release = yield* latestStable(repo);
  const clone = yield* bareClone(repo, root);

  if (release !== null)
    yield* git(clone, ["check-ref-format", `refs/tags/${release.tag_name}`]);

  yield* git(clone, ["check-ref-format", `refs/heads/${branch}`]);
  yield* git(clone, [
    "fetch",
    "--quiet",
    "--atomic",
    "--no-write-fetch-head",
    "--no-tags",
    "--no-recurse-submodules",
    "origin",
    ...(release === null
      ? []
      : [`+refs/tags/${release.tag_name}:refs/upkeep/release`]),
    `+refs/heads/${branch}:refs/upkeep/head`,
  ]);

  const releaseCommit =
    release === null
      ? null
      : (yield* git(clone, [
          "rev-parse",
          "--verify",
          "refs/upkeep/release^{commit}",
        ])).trim();

  const head = (yield* git(clone, [
    "rev-parse",
    "--verify",
    "refs/upkeep/head^{commit}",
  ])).trim();

  if (
    release !== null &&
    releaseCommit !== null &&
    !(yield* isAncestor(clone, releaseCommit, head))
  )
    return yield* new ReleaseError({
      message: `Release ${release.tag_name} isn't in ${branch}'s history`,
    });

  const upstream =
    settings.versioning === "fork" || settings.versioning === "fork-base-js"
      ? yield* upstreamBase(clone, head, settings).pipe(
          Effect.mapError(
            (error) =>
              new ReleaseError({
                message: `Upstream base unavailable: ${error.message}`,
              }),
          ),
          Effect.result,
        )
      : undefined;

  const changes = yield* collect(
    clone,
    releaseCommit,
    head,
    settings,
    path.join(root, "upstreams", repo),
  );

  const findings = classify(changes.facts, settings);

  const errors = [
    ...changes.errors,
    ...(upstream !== undefined && Result.isFailure(upstream)
      ? [upstream.failure.message]
      : []),
  ];

  const snapshot: Domain.ReleaseSnapshot = {
    id: "",
    repo,
    name: repo.split("/").at(-1) ?? repo,
    branch,
    releaseTag: release?.tag_name ?? null,
    releaseCommit,
    head,
    ...(upstream !== undefined &&
      Result.isSuccess(upstream) && { upstreamBase: upstream.success }),
    checkedAt: yield* Clock.currentTimeMillis,
    policyId: policyId(settings),
    comparisonId: "",
    url:
      releaseCommit === null
        ? `https://github.com/${repo}/commits/${head}`
        : `https://github.com/${repo}/compare/${releaseCommit}...${head}`,
    commits: changes.commits,
    findings,
    files: changes.files,
    automaticSuggestion: highestImpact(
      findings.map((finding) => finding.automaticImpact),
    ),
    suggestion: "none",
    reviewed: false,
    complete:
      errors.length === 0 && findings.every((finding) => finding.complete),
    errors,
  };

  const recipe =
    config?.publish === undefined
      ? null
      : yield* readRecipe(clone, head, config.publish);

  return { snapshot, recipe };
});

/** Read one repository for the page, with why when it couldn't be. */
const scan = Effect.fnUntraced(function* (
  repo: string,
  config: SettingsFile.ReleaseRepo | undefined,
  root: string,
) {
  const settings = settingsOf(config);
  const attemptedAt = yield* Clock.currentTimeMillis;

  const branch =
    config?.branch ??
    (yield* Api.json(
      { endpoint: `repos/${repo}`, method: "GET" },
      RepositoryInfo,
    ).pipe(
      Effect.map((info) => info.default_branch),
      Effect.orElseSucceed(() => "main"),
    ));

  const read = yield* compare(repo, branch, config, root).pipe(
    Effect.timeout("10 minutes"),
    Effect.result,
  );

  return {
    repo,
    name: repo.split("/").at(-1) ?? repo,
    branch,
    policyId: policyId(settings),
    versioning: settings.versioning,
    fork: settings.fork,
    notify: {
      enabled: config?.notify?.enabled ?? true,
      minimumImpact: config?.notify?.minimumImpact ?? "patch",
    },
    recipe: Result.isSuccess(read) ? read.success.recipe : null,
    snapshot: Result.isSuccess(read) ? read.success.snapshot : null,
    error: Result.isFailure(read) ? why(read.failure) : null,
    attemptedAt,
  } satisfies Domain.ReleaseScan;
});

export const unreleased = Effect.fnUntraced(function* () {
  const reporter = yield* Reporter;
  const repos = yield* reporter.repos(Catalogue.unreleased.id);

  yield* RunLog.info(
    `${repos.length} ${repos.length === 1 ? "repository is" : "repositories are"} tracked for ${Catalogue.unreleased.id}`,
  );

  if (repos.length === 0) return skipped;

  const settings = yield* SettingsFile.load();
  const root = yield* cacheRoot;

  const scans = yield* Effect.forEach(
    repos,
    (repo) =>
      Effect.gen(function* () {
        const found = yield* scan(repo, settingsFor(settings, repo), root);

        yield* reporter.putRelease(found);

        if (found.error !== null) yield* RunLog.warn(`${repo}: ${found.error}`);
        else if (found.snapshot !== null)
          yield* RunLog.info(
            `${repo}: ${found.snapshot.releaseTag ?? "unreleased"} -> ${found.branch}, ${found.snapshot.commits.length} commits, the policy suggests ${found.snapshot.automaticSuggestion}${found.snapshot.complete ? "" : ", incomplete"}`,
          );

        return found;
      }),
    { concurrency: 4 },
  );

  const failed = scans.filter((found) => found.error !== null);

  const suggested = scans.filter(
    (found) =>
      found.snapshot !== null && found.snapshot.automaticSuggestion !== "none",
  );

  yield* summary(
    [
      `Compared ${scans.length} ${scans.length === 1 ? "repository" : "repositories"}`,
      suggested.length === 0
        ? "none has changes worth a release"
        : `changes worth a release in ${suggested.map((found) => found.repo.split("/").at(-1)).join(", ")}`,
      ...(failed.length === 0
        ? []
        : [
            `couldn't read ${failed.map((found) => found.repo.split("/").at(-1)).join(", ")}`,
          ]),
    ].join("; "),
  );
});
