/**
 * The datasources: where a dependency's releases come from. npm and PyPI
 * through their registries, GitHub releases, tags and refs through the GitHub
 * API. Lookups are cached for the run, so a package many repositories use is
 * read once, and GitHub responses are kept between runs and asked for again
 * conditionally, so what hasn't changed costs no rate limit.
 */
import { Api, Gh, GhCommandError } from "@timmo001/effect-gh";
import {
  Cache,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
} from "effect";
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

/**
 * GitHub responses kept between runs by URL, with the validators to send
 * back: a 304 costs no rate limit, so an unchanged repository is read free.
 */
const Kept = Schema.Record(
  Schema.String,
  Schema.Struct({
    validators: Schema.Struct({
      etag: Schema.optionalKey(Schema.String),
      lastModified: Schema.optionalKey(Schema.String),
    }),
    value: Schema.Json,
  }),
);

type Kept = typeof Kept.Type;

const keptFile = Config.String("XDG_CACHE_HOME").pipe(
  Config.orElse(() =>
    Config.String("HOME").pipe(Config.map((home) => `${home}/.cache`)),
  ),
  Config.map((root) => `${root}/upkeep/deps/github.json`),
);

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
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = yield* keptFile;

      const provide = <A, E>(effect: Effect.Effect<A, E, Gh>) =>
        Effect.provideService(effect, Gh, gh);

      const earlier: Kept = yield* fs.readFileString(file).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Kept))),
        Effect.orElseSucceed(() => ({})),
      );

      // Only what this run read is written back, so dropped dependencies go
      const kept: Record<string, Kept[string]> = {};

      yield* Effect.addFinalizer(() =>
        fs
          .makeDirectory(path.dirname(file), { recursive: true })
          .pipe(
            Effect.andThen(
              fs.writeFileString(`${file}.tmp`, JSON.stringify(kept)),
            ),
            Effect.andThen(fs.rename(`${file}.tmp`, file)),
            Effect.ignore,
          ),
      );

      /**
       * A GitHub GET sent with the last run's validators, answered from what
       * was kept when GitHub says nothing changed. One that can never change,
       * such as a commit by its SHA, isn't asked again at all.
       */
      const get = Effect.fnUntraced(function* (
        endpoint: string,
        options: {
          readonly page?: number;
          readonly immutable?: boolean;
        } = {},
      ) {
        const query =
          options.page === undefined
            ? undefined
            : { per_page: perPage, page: options.page };

        const key =
          query === undefined
            ? endpoint
            : `${endpoint}?per_page=${query.per_page}&page=${query.page}`;

        const previous = earlier[key];

        if (previous !== undefined && options.immutable === true) {
          kept[key] = previous;

          return previous.value;
        }

        const response = yield* provide(
          Api.conditional(
            { endpoint, ...(query !== undefined && { query }) },
            Schema.Json,
            previous?.validators,
          ),
        );

        const current = Api.Conditional.$match(response, {
          Modified: ({ validators, value }) => ({ validators, value }),
          NotModified: () => previous,
        });

        if (current === undefined)
          return yield* new DepsError({
            message: `GitHub said ${endpoint} hadn't changed, with nothing kept`,
          });

        kept[key] = current;

        return current.value;
      });

      /** Every page of a GitHub list, each page its own conditional GET. */
      const list = Effect.fnUntraced(function* (endpoint: string) {
        const items: Array<Schema.Json> = [];

        for (let page = 1; ; page += 1) {
          const batch = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Json),
          )(yield* get(endpoint, { page }));

          items.push(...batch);

          if (batch.length < perPage) return items;
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

      const releases = Effect.fnUntraced(function* (repository: string) {
        const all = yield* Schema.decodeUnknownEffect(
          Schema.Array(GithubRelease),
        )(yield* list(`repos/${repository}/releases`));

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
            releases(repository),
            list(`repos/${repository}/tags`).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Tag))),
            ),
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
              dependency.datasource === "github-tags"
                ? dependency.currentValue
                : "",
            ].join("\u0000"),
          ),
      });
    }),
  );
}
