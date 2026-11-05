/**
 * The datasources: where a dependency's releases come from. npm through its
 * registry, GitHub releases, tags and refs through the GitHub API. Lookups
 * are cached for the run, so a package many repositories use is read once.
 */
import { Api, Gh, GhCommandError } from "@timmo001/effect-gh";
import { Cache, Context, Effect, Layer, Schema } from "effect";
import { HttpClient } from "effect/http";
import semver from "semver";
import { ghReason } from "../Failure";
import {
  type Dependency,
  DepsError,
  type Release,
  type Releases,
} from "./Policy";

const NpmPackage = Schema.Struct({
  versions: Schema.Record(Schema.String, Schema.Unknown),
  time: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  "dist-tags": Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  repository: Schema.optionalKey(
    Schema.Union([
      Schema.String,
      Schema.Struct({ url: Schema.optionalKey(Schema.String) }),
    ]),
  ),
});

const GithubRelease = Schema.Struct({
  tag_name: Schema.String,
  published_at: Schema.NullOr(Schema.String),
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
});

const Tag = Schema.Struct({
  name: Schema.String,
  commit: Schema.Struct({ sha: Schema.String }),
});

const Commit = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({
    committer: Schema.NullOr(
      Schema.Struct({ date: Schema.optionalKey(Schema.String) }),
    ),
  }),
});

const RepositoryInfo = Schema.Struct({ default_branch: Schema.String });

/** A repository's URL as `https://github.com/owner/name`, from npm's forms. */
export const sourceUrl = (repository: string) =>
  repository
    .replace(/^git\+/, "")
    .replace(/^git:\/\/github\.com\//, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^github:/, "https://github.com/")
    .replace(/^(?<repo>[\w.-]+\/[\w.-]+)$/, "https://github.com/$<repo>")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

/** `owner/name` from a GitHub repository reference. */
const githubRepository = (name: string) =>
  name
    .replace(/^(?:git\+)?https:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "");

const failed = (datasource: string) => (cause: unknown) =>
  new DepsError({
    message: `${datasource} lookup failed: ${
      cause instanceof GhCommandError
        ? ghReason(cause)
        : cause instanceof Error
          ? cause.message
          : String(cause)
    }`,
  });

/** The datasources Upkeep reads. */
export const supported = new Set([
  "npm",
  "github-releases",
  "github-tags",
  "git-refs",
]);

/** The tags newer than this many get their commit dates read. */
const datedTags = 10;

export class Datasources extends Context.Service<
  Datasources,
  {
    readonly lookup: (
      dependency: Dependency,
    ) => Effect.Effect<Releases, DepsError>;
  }
>()("@upkeep/worker/deps/Datasources") {
  static readonly layer = Layer.effect(
    Datasources,
    Effect.gen(function* () {
      const gh = yield* Gh;
      const http = yield* HttpClient.HttpClient;

      const provide = <A, E>(effect: Effect.Effect<A, E, Gh>) =>
        Effect.provideService(effect, Gh, gh);

      const npm = Effect.fnUntraced(function* (name: string) {
        const response = yield* http.get(
          `https://registry.npmjs.org/${name.replace("/", "%2F")}`,
        );

        if (response.status !== 200)
          return yield* new DepsError({
            message: `npm returned ${response.status} for ${name}`,
          });

        const metadata = yield* Schema.decodeUnknownEffect(NpmPackage)(
          yield* response.json,
        );

        const repository = Schema.is(Schema.String)(metadata.repository)
          ? metadata.repository
          : metadata.repository?.url;

        const latest = metadata["dist-tags"]?.latest;

        return {
          releases: Object.keys(metadata.versions).map((version): Release => ({
            version,
            date: metadata.time?.[version],
          })),
          latest,
          sourceUrl:
            repository === undefined || repository === ""
              ? null
              : sourceUrl(repository),
        } satisfies Releases;
      });

      const releases = Effect.fnUntraced(function* (repository: string) {
        const pages = yield* provide(
          Api.pages(
            {
              endpoint: `repos/${repository}/releases`,
              method: "GET",
              query: { per_page: 100 },
            },
            Schema.Array(GithubRelease),
          ),
        );

        return pages.flat().filter((release) => !release.draft);
      });

      const commitDate = Effect.fnUntraced(function* (
        repository: string,
        ref: string,
      ) {
        const commit = yield* provide(
          Api.json(
            {
              endpoint: `repos/${repository}/commits/${encodeURIComponent(ref)}`,
              method: "GET",
            },
            Commit,
          ),
        );

        return { sha: commit.sha, date: commit.commit.committer?.date };
      });

      const tags = Effect.fnUntraced(function* (
        repository: string,
        current: string,
      ) {
        const [published, pages] = yield* Effect.all(
          [
            releases(repository),
            provide(
              Api.pages(
                {
                  endpoint: `repos/${repository}/tags`,
                  method: "GET",
                  query: { per_page: 100 },
                },
                Schema.Array(Tag),
              ),
            ),
          ],
          { concurrency: 2 },
        );

        const dates = new Map(
          published.map((release) => [release.tag_name, release.published_at]),
        );

        const floor = semver.coerce(current)?.version;

        // Tags newer than the version in use, which an update can pick
        const newer = pages
          .flat()
          .map((tag) => ({ tag, version: semver.coerce(tag.name)?.version }))
          .filter(
            ({ version }) =>
              version !== undefined &&
              (floor === undefined || semver.gte(version, floor)),
          )
          .toSorted((a, b) =>
            semver.rcompare(a.version ?? "0.0.0", b.version ?? "0.0.0"),
          )
          .slice(0, datedTags)
          .map(({ tag }) => tag.name);

        return yield* Effect.forEach(
          pages.flat(),
          Effect.fnUntraced(function* (tag) {
            let date = dates.get(tag.name) ?? undefined;

            if (date === undefined && newer.includes(tag.name))
              date = (yield* commitDate(repository, tag.commit.sha)).date;

            return {
              version: tag.name,
              digest: tag.commit.sha,
              date,
            } satisfies Release;
          }),
          { concurrency: 4 },
        );
      });

      const cache = yield* Cache.make({
        capacity: 4096,
        lookup: (key: string) => {
          const [datasource = "", packageName = "", ref = ""] =
            key.split("\u0000");

          const repository = githubRepository(packageName);
          const url = `https://github.com/${repository}`;

          const lookup = Effect.gen(function* () {
            if (datasource === "npm") return yield* npm(packageName);

            if (datasource === "github-releases")
              return {
                releases: (yield* releases(repository)).map(
                  (release): Release => ({
                    version: release.tag_name,
                    date: release.published_at ?? undefined,
                    prerelease: release.prerelease,
                  }),
                ),
                sourceUrl: url,
              } satisfies Releases;

            if (datasource === "github-tags")
              return {
                releases: yield* tags(repository, ref),
                sourceUrl: url,
              } satisfies Releases;

            if (datasource === "git-refs") {
              const branch =
                ref === "HEAD" || /^[a-f\d]{7,40}$/i.test(ref)
                  ? (yield* provide(
                      Api.json(
                        { endpoint: `repos/${repository}`, method: "GET" },
                        RepositoryInfo,
                      ),
                    )).default_branch
                  : ref;

              const commit = yield* commitDate(repository, branch);

              return {
                releases: [
                  {
                    version: branch,
                    digest: commit.sha,
                    date: commit.date,
                  },
                ],
                sourceUrl: url,
              } satisfies Releases;
            }

            return yield* new DepsError({
              message: `no ${datasource} datasource`,
            });
          });

          return lookup.pipe(
            Effect.mapError((cause) =>
              cause instanceof DepsError ? cause : failed(datasource)(cause),
            ),
          );
        },
      });

      return Datasources.of({
        lookup: (dependency) =>
          Cache.get(
            cache,
            [
              dependency.datasource,
              dependency.packageName,
              dependency.datasource === "git-refs" ||
              dependency.datasource === "github-tags"
                ? dependency.currentValue
                : "",
            ].join("\u0000"),
          ),
      });
    }),
  );
}
