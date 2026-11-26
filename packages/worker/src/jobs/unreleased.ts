/**
 * The unreleased job: for each repository tracked for it, compare its
 * watched branch with its last stable release, classify every net change by
 * its policy and settings, and send the comparison to the server for the
 * Releases page, where you review it and hand it to an agent to publish. A
 * repository that can't be read is sent with why, so the page keeps its last
 * comparison as stale.
 * Each one is read from a bare clone in the cache, without a checkout. Their
 * default branches and releases are read together through GraphQL, a query
 * for many repositories, falling back to REST reads for each while the
 * GraphQL limit is low.
 */
import { Api, Graphql, Repository } from "@timmo001/effect-gh";
import { Catalogue, type Domain } from "@upkeep/api";
import { highestImpact } from "@upkeep/api/releases";
import {
  Clock,
  Config,
  Effect,
  FileSystem,
  Option,
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
import { Reporter, summary } from "../Reporter";
import * as RateLimits from "../RateLimits";
import * as RunLog from "../RunLog";
import * as SettingsFile from "../settings";
import { skipped } from "../Worker";

/** Where the job keeps its clones and what it read of submodules' upstreams. */
const cacheRoot = Config.String("XDG_CACHE_HOME").pipe(
  Config.orElse(() =>
    Config.String("HOME").pipe(Config.map((home) => `${home}/.cache`)),
  ),
  Config.map((root) => `${root}/upkeep/unreleased`),
);

/** A repository's settings, matched without regard to case. */
const settingsFor = (
  settings: SettingsFile.Settings,
  repo: string,
): SettingsFile.ReleaseRepo | undefined =>
  Object.entries(settings.releases?.repos ?? {}).find(
    ([name]) => name.toLowerCase() === repo.toLowerCase(),
  )?.[1];

/** A bare clone of the repository in the cache, made the first time. */
const bareClone = Effect.fnUntraced(function* (repo: string, root: string) {
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

const StableRelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String),
});

const ReleaseList = Schema.Array(
  Schema.Struct({ draft: Schema.Boolean, prerelease: Schema.Boolean }),
);

/**
 * What one GraphQL query read of a repository for {@link latestStable} and
 * its default branch, so most repositories need no REST reads at all.
 */
interface Known {
  readonly branch: string | null;
  readonly latest: typeof StableRelease.Type | null;
  /** Whether it has a stable release, or null when the query can't tell. */
  readonly stable: boolean | null;
}

/**
 * A repository's latest stable release, or null when it has never had one.
 * GitHub answers 404 both when there's none and when no stable release is
 * marked latest, so the list tells them apart. What the batched query read
 * stands in for the REST reads when it's there.
 */
const latestStable = Effect.fnUntraced(function* (
  repo: string,
  known: Known | undefined,
) {
  const latest =
    known === undefined
      ? yield* Api.json(
          { endpoint: `repos/${repo}/releases/latest`, method: "GET" },
          StableRelease,
        ).pipe(
          Effect.map(Option.some),
          Effect.catchIf(
            (error) => /\b404\b|Not Found/.test(why(error)),
            () => Effect.succeed(Option.none()),
          ),
        )
      : Option.fromNullishOr(known.latest);

  if (Option.isSome(latest)) {
    if (
      latest.value.draft ||
      latest.value.prerelease ||
      latest.value.published_at === null
    )
      return yield* new ReleaseError({
        message: "No published stable release is available",
      });

    return latest.value;
  }

  const stable =
    known?.stable ??
    (yield* Api.pages(
      {
        endpoint: `repos/${repo}/releases`,
        method: "GET",
        query: { per_page: 100 },
      },
      ReleaseList,
    ))
      .flat()
      .some((release) => !release.draft && !release.prerelease);

  if (stable)
    return yield* new ReleaseError({
      message: "GitHub has stable releases, but none is marked as the latest",
    });

  return null;
});

const RepositoryInfo = Schema.Struct({ default_branch: Schema.String });

const Node = Schema.NullOr(
  Schema.Struct({
    defaultBranchRef: Schema.NullOr(Schema.Struct({ name: Schema.String })),
    latestRelease: Schema.NullOr(
      Schema.Struct({
        tagName: Schema.String,
        isDraft: Schema.Boolean,
        isPrerelease: Schema.Boolean,
        publishedAt: Schema.NullOr(Schema.String),
      }),
    ),
    releases: Schema.Struct({
      totalCount: Schema.Number,
      nodes: Schema.Array(
        Schema.Struct({
          isDraft: Schema.Boolean,
          isPrerelease: Schema.Boolean,
        }),
      ),
    }),
  }),
);

const Batch = Schema.Record(Schema.String, Node);

/** How many repositories one query reads. */
const batchSize = 50;

/**
 * Read each repository's default branch and releases in GraphQL queries of
 * {@link batchSize}, in place of two or three REST reads each, by its name in
 * lower case. Uses REST instead, reading nothing here, while the GraphQL
 * limit is the low one; a query that fails leaves its repositories to REST.
 */
const readAll = Effect.fnUntraced(function* (repos: ReadonlyArray<string>) {
  const known = new Map<string, Known>();
  const low = yield* RateLimits.low();

  if (Option.isSome(low) && low.value.resource === "graphql") {
    yield* RunLog.info(
      "GitHub's GraphQL rate limit is low, so reading each repository through REST",
    );

    return known;
  }

  for (let start = 0; start < repos.length; start += batchSize) {
    const chunk = repos.slice(start, start + batchSize);

    const fields = chunk.map((repo, index) => {
      const [owner = "", name = ""] = repo.split("/");

      return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
        defaultBranchRef { name }
        latestRelease { tagName isDraft isPrerelease publishedAt }
        releases(first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
          totalCount
          nodes { isDraft isPrerelease }
        }
      }`;
    });

    const read = yield* Graphql.query(
      `query { ${fields.join("\n")} }`,
      {},
      Batch,
    ).pipe(Effect.result);

    if (Result.isFailure(read)) {
      yield* RunLog.warn(
        `Couldn't read ${chunk.length} repositories through GraphQL, so reading them through REST: ${why(read.failure)}`,
      );

      continue;
    }

    for (const [index, repo] of chunk.entries()) {
      const node = read.success[`r${index}`];

      if (node === undefined || node === null) continue;

      const latest = node.latestRelease;

      const listed = node.releases.nodes.some(
        (release) => !release.isDraft && !release.isPrerelease,
      );

      known.set(repo.toLowerCase(), {
        branch: node.defaultBranchRef?.name ?? null,
        latest:
          latest === null
            ? null
            : {
                tag_name: latest.tagName,
                draft: latest.isDraft,
                prerelease: latest.isPrerelease,
                published_at: latest.publishedAt,
              },
        stable:
          listed || node.releases.totalCount <= node.releases.nodes.length
            ? listed
            : null,
      });
    }
  }

  return known;
});

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
  known: Known | undefined,
) {
  const path = yield* Path.Path;
  const settings = settingsOf(config);
  const release = yield* latestStable(repo, known);
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

  const findings = classify(changes.facts, settings, changes.updatesOnly);

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

  return snapshot;
});

/** Read one repository for the page, with why when it couldn't be. */
const scan = Effect.fnUntraced(function* (
  repo: string,
  config: SettingsFile.ReleaseRepo | undefined,
  root: string,
  known: Known | undefined,
) {
  const settings = settingsOf(config);
  const attemptedAt = yield* Clock.currentTimeMillis;

  const branch =
    config?.branch ??
    known?.branch ??
    (yield* Api.json(
      { endpoint: `repos/${repo}`, method: "GET" },
      RepositoryInfo,
    ).pipe(
      Effect.map((info) => info.default_branch),
      Effect.orElseSucceed(() => "main"),
    ));

  const read = yield* compare(repo, branch, config, root, known).pipe(
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
    snapshot: Result.isSuccess(read) ? read.success : null,
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
  const known = yield* readAll(repos);

  const scans = yield* Effect.forEach(
    repos,
    (repo) =>
      Effect.gen(function* () {
        const found = yield* scan(
          repo,
          settingsFor(settings, repo),
          root,
          known.get(repo.toLowerCase()),
        );

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
