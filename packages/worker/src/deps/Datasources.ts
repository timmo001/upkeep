/**
 * The datasources: where a dependency's releases come from. npm and PyPI
 * through their registries, GitHub releases, tags and refs through the GitHub
 * API. Lookups are cached for the run, so a package many repositories use is
 * read once, and GitHub responses are kept between runs and asked for again
 * conditionally, so what hasn't changed costs no rate limit. Release and tag
 * lists stop at the page that reaches the version in use.
 */
import { Gh, GhCommandError } from "@timmo001/effect-gh";
import { Cache, Context, Effect, Layer, Schema } from "effect";
import { HttpClient } from "effect/http";
import semver from "semver";
import { ghReason } from "../Failure";
import * as Kept from "../Kept";
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

const PypiPackage = Schema.Struct({
  info: Schema.Struct({
    version: Schema.String,
    project_urls: Schema.optionalKey(
      Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
    ),
  }),
  releases: Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        upload_time_iso_8601: Schema.optionalKey(Schema.String),
        yanked: Schema.optionalKey(Schema.Boolean),
      }),
    ),
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

/** A page size GitHub allows, so most lists are one request. */
const perPage = 100;

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
  "pypi",
  "github-releases",
  "github-tags",
  "git-refs",
]);

/** Whether a version name is older than the version in use, `floor`. */
const olderThan = (name: string, floor: string | undefined) => {
  const version = semver.coerce(name)?.version;

  return (
    version !== undefined && floor !== undefined && semver.lt(version, floor)
  );
};

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
      const kept = yield* Kept.make("deps");

      const provide = <A, E>(effect: Effect.Effect<A, E, Gh>) =>
        Effect.provideService(effect, Gh, gh);

      /** A conditional GitHub GET, a page of a list when `page` is given. */
      const get = (
        endpoint: string,
        options: {
          readonly page?: number;
          readonly immutable?: boolean;
        } = {},
      ) =>
        provide(
          kept.get(
            {
              endpoint,
              ...(options.page !== undefined && {
                query: { per_page: perPage, page: options.page },
              }),
            },
            { immutable: options.immutable ?? false },
          ),
        ).pipe(Effect.map(({ value }) => value));

      /**
       * The pages of a GitHub list, each its own conditional GET. Releases
       * come newest first and tags in version order, so once a page ends
       * older than `current`, the version in use, the rest is older still.
       */
      const list = Effect.fnUntraced(function* <A>(
        endpoint: string,
        item: Schema.Decoder<A>,
        nameOf: (item: A) => string,
        current: string,
      ) {
        const floor = semver.coerce(current)?.version;
        const items: Array<A> = [];

        for (let page = 1; ; page += 1) {
          const batch = yield* Schema.decodeUnknownEffect(Schema.Array(item))(
            yield* get(endpoint, { page }),
          );

          items.push(...batch);

          const last = batch.at(-1);

          if (
            batch.length < perPage ||
            (last !== undefined && olderThan(nameOf(last), floor))
          )
            return items;
        }
      });

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

      const pypi = Effect.fnUntraced(function* (name: string) {
        const response = yield* http.get(
          `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
        );

        if (response.status !== 200)
          return yield* new DepsError({
            message: `PyPI returned ${response.status} for ${name}`,
          });

        const metadata = yield* Schema.decodeUnknownEffect(PypiPackage)(
          yield* response.json,
        );

        const source = Object.values(metadata.info.project_urls ?? {})
          .map((url) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.exec(url))
          .find((match) => match !== null)?.[0];

        return {
          releases: Object.entries(metadata.releases)
            // A version with no files, or only yanked ones, can't be installed
            .filter(([, files]) => files.some((file) => file.yanked !== true))
            .map(([version, files]): Release => ({
              version,
              date: files[0]?.upload_time_iso_8601,
            })),
          latest: metadata.info.version,
          sourceUrl: source === undefined ? null : sourceUrl(source),
        } satisfies Releases;
      });

      const releases = Effect.fnUntraced(function* (
        repository: string,
        current: string,
      ) {
        const all = yield* list(
          `repos/${repository}/releases`,
          GithubRelease,
          (release) => release.tag_name,
          current,
        );

        return all.filter((release) => !release.draft);
      });

      const commitDate = Effect.fnUntraced(function* (
        repository: string,
        ref: string,
      ) {
        const commit = yield* Schema.decodeUnknownEffect(Commit)(
          yield* get(`repos/${repository}/commits/${encodeURIComponent(ref)}`, {
            immutable: /^[a-f\d]{40}$/i.test(ref),
          }),
        );

        return { sha: commit.sha, date: commit.commit.committer?.date };
      });

      const tags = Effect.fnUntraced(function* (
        repository: string,
        current: string,
      ) {
        const [published, all] = yield* Effect.all(
          [
            releases(repository, current),
            list(`repos/${repository}/tags`, Tag, (tag) => tag.name, current),
          ],
          { concurrency: 2 },
        );

        const dates = new Map(
          published.map((release) => [release.tag_name, release.published_at]),
        );

        const floor = semver.coerce(current)?.version;

        // Tags newer than the version in use, which an update can pick
        const newer = all
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
          all,
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

            if (datasource === "pypi") return yield* pypi(packageName);

            if (datasource === "github-releases")
              return {
                releases: (yield* releases(repository, ref)).map(
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
                  ? (yield* Schema.decodeUnknownEffect(RepositoryInfo)(
                      yield* get(`repos/${repository}`),
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
              dependency.datasource === "github-tags" ||
              dependency.datasource === "github-releases"
                ? dependency.currentValue
                : "",
            ].join("\u0000"),
          ),
      });
    }),
  );
}
