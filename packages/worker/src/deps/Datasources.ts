/**
 * The datasources: where a dependency's releases come from. npm and PyPI
 * through their registries, Node.js and Python versions from nodejs.org and
 * python.org, GitHub releases, tags and refs through the GitHub
 * API. Lookups are cached for the run, so a package many repositories use is
 * read once, and GitHub responses are kept between runs and asked for again
 * conditionally, so what hasn't changed costs no rate limit. Release and tag
 * lists stop at the page that reaches the version in use. A config's custom
 * datasources are fetched and run through their JSONata transforms. An
 * update's release notes come from its source's GitHub releases.
 */
import { Gh, GhCommandError } from "@timmo001/effect-gh";
import jsonata from "jsonata";
import { Cache, Context, Effect, Layer, Match, Schema } from "effect";
import { Yaml } from "effect/encoding";
import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import semver from "semver";
import { ghReason } from "../Failure";
import * as Kept from "../Kept";
import { render } from "./Managers";
import { compareVersions, dockerVersion } from "./Planner";
import {
  type CustomDatasource,
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

/** A release in nodejs.org's index, its version with a leading `v`. */
const NodeRelease = Schema.Struct({
  version: Schema.String,
  date: Schema.optionalKey(Schema.String),
});

/** A release in python.org's downloads API, named `Python 3.14.2`. */
const PythonRelease = Schema.Struct({
  name: Schema.String,
  release_date: Schema.optionalKey(Schema.NullOr(Schema.String)),
  pre_release: Schema.optionalKey(Schema.Boolean),
});

const GithubRelease = Schema.Struct({
  tag_name: Schema.String,
  published_at: Schema.NullOr(Schema.String),
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
  html_url: Schema.optionalKey(Schema.String),
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

const RegistryToken = Schema.Struct({
  token: Schema.optionalKey(Schema.String),
  access_token: Schema.optionalKey(Schema.String),
});

const TagList = Schema.Struct({
  tags: Schema.NullOr(Schema.Array(Schema.String)),
});

/** An image manifest or an index of them, as far as a date needs it. */
const ImageManifest = Schema.Struct({
  manifests: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        digest: Schema.String,
        platform: Schema.optionalKey(
          Schema.Struct({ architecture: Schema.String, os: Schema.String }),
        ),
      }),
    ),
  ),
  config: Schema.optionalKey(Schema.Struct({ digest: Schema.String })),
});

const ImageConfig = Schema.Struct({
  created: Schema.optionalKey(Schema.String),
});

/** A tag from Docker Hub's own API, which a date costs no pull from. */
const HubTag = Schema.Struct({
  digest: Schema.optionalKey(Schema.String),
  tag_last_pushed: Schema.optionalKey(Schema.NullOr(Schema.String)),
  last_updated: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/** The manifest types a digest is read for, as Renovate asks for them. */
const manifestTypes = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
].join(", ");

/** The most pages of tags read for one image. */
const maxTagPages = 100;

/** Newer tags dated overall and in the major in use, as `datedTags` for GitHub. */
const datedImages = 5;

/**
 * Where an image lives, as Docker reads its name: a first part with a dot or
 * port, or `localhost`, is the registry, and anything else is on Docker Hub,
 * where a one-part name is an official image under `library/`.
 */
export const imageLocation = (name: string) => {
  const [first = "", ...rest] = name.split("/");

  const registry =
    rest.length > 0 &&
    (first.includes(".") || first.includes(":") || first === "localhost")
      ? first
      : undefined;

  const path = registry === undefined ? name : rest.join("/");

  if (
    registry === undefined ||
    registry === "docker.io" ||
    registry === "index.docker.io" ||
    registry === "registry-1.docker.io"
  )
    return {
      registry: "registry-1.docker.io",
      repository: path.includes("/") ? path : `library/${path}`,
      hub: true,
    };

  return { registry, repository: path, hub: false };
};

/**
 * The tags worth a date and digest: of the tags the one in use could move to,
 * the same shape and newer, the newest few overall and in its major.
 */
export const tagsToDate = (
  tags: ReadonlyArray<string>,
  current: string,
): ReadonlyArray<string> => {
  const now = dockerVersion(current);

  if (now === undefined) return [];

  const newer = tags
    .flatMap((tag) => {
      const version = dockerVersion(tag);

      return version !== undefined &&
        version.suffix === now.suffix &&
        version.parts.length === now.parts.length &&
        (version.prerelease === undefined || now.prerelease !== undefined) &&
        compareVersions(version, now) > 0
        ? [{ tag, version }]
        : [];
    })
    .toSorted((a, b) => compareVersions(b.version, a.version));

  return [
    ...new Set(
      [
        ...newer.slice(0, datedImages),
        ...newer
          .filter(({ version }) => version.parts[0] === now.parts[0])
          .slice(0, datedImages),
      ].map(({ tag }) => tag),
    ),
  ];
};

/** A `WWW-Authenticate` header's parameters, when it's a Bearer challenge. */
const bearerChallenge = (header: string | undefined) => {
  if (header === undefined || !/^Bearer\s/i.test(header)) return undefined;

  return Object.fromEntries(
    [...header.matchAll(/(?<key>\w+)="(?<value>[^"]*)"/g)].map((match) => [
      match.groups?.key ?? "",
      match.groups?.value ?? "",
    ]),
  );
};

/** What a custom datasource's transforms must leave, as Renovate reads it. */
const CustomReleases = Schema.Struct({
  releases: Schema.Array(
    Schema.Struct({
      version: Schema.String,
      releaseTimestamp: Schema.optional(
        Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
      ),
      digest: Schema.optional(Schema.String),
      isStable: Schema.optional(Schema.Boolean),
    }),
  ),
  sourceUrl: Schema.optional(Schema.String),
});

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
  "node-version",
  "python-version",
  "github-releases",
  "github-tags",
  "git-refs",
  "docker",
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

/** An update's release notes, and where they and its changes are. */
export interface Notes {
  /** The notes of each release it takes in, newest first, empty when none have any. */
  readonly text: string;
  readonly url?: string | undefined;
  readonly compare?: string | undefined;
}

/**
 * An update's release notes from its source's GitHub releases: those after
 * `from` up to `to`, tagged with the version, `v` and the version, or the
 * package's name, `@` and the version, as monorepos tag them. `undefined`
 * when there's no release for `to`.
 */
export const notesBetween = (
  repository: string,
  releases: ReadonlyArray<Release>,
  name: string,
  from: string,
  to: string,
): Notes | undefined => {
  const versionOf = (tag: string) =>
    semver.valid(tag.startsWith(`${name}@`) ? tag.slice(name.length + 1) : tag);

  const low = semver.coerce(from)?.version;
  const high = versionOf(to);

  if (low === undefined || high === null) return undefined;

  const target = releases.find(
    (release) => versionOf(release.version) === high,
  );

  if (target === undefined) return undefined;

  const text = releases
    .filter((release) => {
      const version = versionOf(release.version);

      return (
        version !== null && semver.gt(version, low) && semver.lte(version, high)
      );
    })
    .flatMap((release) => {
      const notes = release.notes?.trim() ?? "";

      return notes === "" ? [] : [notes];
    })
    .join("\n\n");

  return {
    text,
    url: target.url,
    compare: `https://github.com/${repository}/compare/${target.version.replace(high, low)}...${target.version}`,
  };
};

export class Datasources extends Context.Service<
  Datasources,
  {
    /** Releases for a dependency, with the config's custom datasources. */
    readonly lookup: (
      dependency: Dependency,
      custom?: Readonly<Record<string, CustomDatasource>>,
    ) => Effect.Effect<Releases, DepsError>;
    /**
     * An update's release notes from its source's GitHub releases, read with
     * the same list as a `github-releases` lookup. `undefined` when its source
     * isn't on GitHub or has no release for `to`.
     */
    readonly notes: (
      dependency: Dependency,
      from: string,
      to: string,
    ) => Effect.Effect<Notes | undefined, DepsError>;
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

      /** Node.js releases from nodejs.org, as Renovate's node-version reads them. */
      const nodeVersions = Effect.gen(function* () {
        const response = yield* http.get("https://nodejs.org/dist/index.json");

        if (response.status !== 200)
          return yield* new DepsError({
            message: `nodejs.org returned ${response.status}`,
          });

        const index = yield* Schema.decodeUnknownEffect(
          Schema.Array(NodeRelease),
        )(yield* response.json);

        return {
          releases: index.map((release): Release => ({
            version: release.version.replace(/^v/, ""),
            date: release.date,
          })),
          sourceUrl: "https://github.com/nodejs/node",
        } satisfies Releases;
      });

      /** CPython releases from python.org, as Renovate's python-version reads them. */
      const pythonVersions = Effect.gen(function* () {
        const response = yield* http.get(
          "https://www.python.org/api/v2/downloads/release/?is_published=true",
        );

        if (response.status !== 200)
          return yield* new DepsError({
            message: `python.org returned ${response.status}`,
          });

        const published = yield* Schema.decodeUnknownEffect(
          Schema.Array(PythonRelease),
        )(yield* response.json);

        return {
          releases: published.flatMap((release): ReadonlyArray<Release> => {
            const version = /^Python (\S+)$/.exec(release.name)?.[1];

            return version === undefined
              ? []
              : [
                  {
                    version,
                    date: release.release_date ?? undefined,
                    prerelease: release.pre_release === true ? true : undefined,
                  },
                ];
          }),
          sourceUrl: "https://github.com/python/cpython",
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

      /**
       * An image's tags from its registry's v2 API, each tag a release, with
       * the digest of the tag in use and dates and digests for the newest
       * tags it could move to. A registry that asks for a Bearer token gets
       * an anonymous pull token from the realm it names. Docker Hub dates come
       * from its own API, as a manifest read there counts against its pull
       * limit; elsewhere, as Renovate dates them, from the image config's
       * `created`.
       */
      const docker = Effect.fnUntraced(function* (
        name: string,
        current: string,
      ) {
        const { registry, repository, hub } = imageLocation(name);
        const origin = `https://${registry}`;
        const base = `${origin}/v2/${repository}`;
        let token: string | undefined;

        const request = Effect.fnUntraced(function* (
          method: "GET" | "HEAD",
          url: string,
          accept?: string,
        ) {
          const send = () =>
            http.execute(
              HttpClientRequest.make(method)(url, {
                headers: {
                  ...(accept !== undefined && { accept }),
                  ...(token !== undefined && {
                    authorization: `Bearer ${token}`,
                  }),
                },
              }),
            );

          const response = yield* send();

          const challenge = bearerChallenge(
            response.headers["www-authenticate"],
          );

          if (
            response.status !== 401 ||
            token !== undefined ||
            challenge?.realm === undefined
          )
            return response;

          const params = new URLSearchParams({
            ...(challenge.service !== undefined && {
              service: challenge.service,
            }),
            scope: challenge.scope ?? `repository:${repository}:pull`,
          });

          const issued = yield* http.get(`${challenge.realm}?${params}`);

          if (issued.status !== 200)
            return yield* new DepsError({
              message: `${registry} gave no token for ${name}: ${issued.status}`,
            });

          const body = yield* Schema.decodeUnknownEffect(RegistryToken)(
            yield* issued.json,
          );

          token = body.token ?? body.access_token;

          return yield* send();
        });

        const json = Effect.fnUntraced(function* <A>(
          url: string,
          schema: Schema.Decoder<A>,
          accept?: string,
        ) {
          const response = yield* request("GET", url, accept);

          if (response.status !== 200)
            return yield* new DepsError({
              message: `${registry} returned ${response.status} for ${name}`,
            });

          return {
            body: yield* Schema.decodeUnknownEffect(schema)(
              yield* response.json,
            ),
            digest: response.headers["docker-content-digest"],
          };
        });

        const tags: Array<string> = [];
        let next: string | undefined = `${base}/tags/list?n=10000`;

        for (let page = 0; next !== undefined && page < maxTagPages; page++) {
          const response: HttpClientResponse.HttpClientResponse =
            yield* request("GET", next);

          if (response.status !== 200)
            return yield* new DepsError({
              message: `${registry} returned ${response.status} for ${name}`,
            });

          const list = yield* Schema.decodeUnknownEffect(TagList)(
            yield* response.json,
          );

          tags.push(...(list.tags ?? []));

          const link: string | undefined = /<(?<url>[^>]+)>;\s*rel="next"/.exec(
            response.headers.link ?? "",
          )?.groups?.url;

          next = link === undefined ? undefined : new URL(link, origin).href;
        }

        const tag = current === "" ? "latest" : current;

        const head = yield* request(
          "HEAD",
          `${base}/manifests/${tag}`,
          manifestTypes,
        );

        const currentDigest =
          head.status === 200
            ? head.headers["docker-content-digest"]
            : undefined;

        /** A tag's date and digest from Docker Hub's API. */
        const fromHub = Effect.fnUntraced(function* (version: string) {
          const response = yield* http.get(
            `https://hub.docker.com/v2/namespaces/${repository.replace("/", "/repositories/")}/tags/${encodeURIComponent(version)}`,
          );

          if (response.status !== 200)
            return yield* new DepsError({
              message: `Docker Hub returned ${response.status} for ${name}:${version}`,
            });

          const found = yield* Schema.decodeUnknownEffect(HubTag)(
            yield* response.json,
          );

          return {
            digest: found.digest,
            date: found.tag_last_pushed ?? found.last_updated ?? undefined,
          };
        });

        /**
         * A tag's digest, and its date from the image config, through the
         * index's linux/amd64 image when it's multi-platform.
         */
        const fromConfig = Effect.fnUntraced(function* (version: string) {
          const top = yield* json(
            `${base}/manifests/${version}`,
            ImageManifest,
            manifestTypes,
          );

          const platforms = top.body.manifests ?? [];

          const image =
            platforms.find(
              ({ platform }) =>
                platform?.os === "linux" && platform.architecture === "amd64",
            ) ?? platforms.find(({ platform }) => platform?.os !== "unknown");

          const config =
            image === undefined
              ? top.body.config
              : (yield* json(
                  `${base}/manifests/${image.digest}`,
                  ImageManifest,
                  manifestTypes,
                )).body.config;

          if (config === undefined)
            return { digest: top.digest, date: undefined };

          const created = yield* json(
            `${base}/blobs/${config.digest}`,
            ImageConfig,
          );

          return { digest: top.digest, date: created.body.created };
        });

        // A tag that can't be dated is left undated, held by any minimum age
        const dated = new Map(
          yield* Effect.forEach(
            tagsToDate(tags, current),
            (version) =>
              (hub ? fromHub(version) : fromConfig(version)).pipe(
                Effect.orElseSucceed(() => ({
                  digest: undefined,
                  date: undefined,
                })),
                Effect.map((found) => [version, found] as const),
              ),
            { concurrency: 4 },
          ),
        );

        return {
          releases: [...new Set([...tags, tag])].map((version): Release => ({
            version,
            digest:
              version === tag ? currentDigest : dated.get(version)?.digest,
            date: dated.get(version)?.date,
          })),
          sourceUrl: null,
        } satisfies Releases;
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

            if (datasource === "node-version") return yield* nodeVersions;

            if (datasource === "python-version") return yield* pythonVersions;

            if (datasource === "docker") return yield* docker(packageName, ref);

            if (datasource === "github-releases")
              return {
                releases: (yield* releases(repository, ref)).map(
                  (release): Release => ({
                    version: release.tag_name,
                    date: release.published_at ?? undefined,
                    prerelease: release.prerelease,
                    notes: release.body ?? "",
                    url: release.html_url,
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

      /**
       * A custom datasource: fetch its URL, parse it by its format, then run
       * each transform over the result in turn.
       */
      const customLookup = Effect.fnUntraced(function* (key: string) {
        const { url, format, transforms } = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              url: Schema.String,
              format: Schema.String,
              transforms: Schema.Array(Schema.String),
            }),
          ),
        )(key);

        const response = yield* http.get(url);

        if (response.status !== 200)
          return yield* new DepsError({
            message: `${url} returned ${response.status}`,
          });

        const text = yield* response.text;

        // Parsed by its format, as Renovate does
        let data: unknown = yield* Effect.try(() =>
          Match.value(format).pipe(
            Match.when("plain", () => ({
              releases: text
                .split(/\r?\n/)
                .map((line) => ({ version: line.trim() })),
            })),
            Match.when("yaml", () => Yaml.parse(text)),
            Match.when("toml", () => Bun.TOML.parse(text)),
            Match.orElse(() => JSON.parse(text)),
          ),
        );

        for (const transform of transforms)
          data = yield* Effect.tryPromise(() =>
            jsonata(transform).evaluate(data),
          );

        const result = yield* Schema.decodeUnknownEffect(CustomReleases)(data);

        return {
          releases: result.releases.map((release): Release => ({
            version: release.version,
            digest: release.digest,
            date:
              release.releaseTimestamp === undefined ||
              release.releaseTimestamp === null
                ? undefined
                : new Date(release.releaseTimestamp).toISOString(),
            prerelease: release.isStable === false ? true : undefined,
          })),
          sourceUrl: result.sourceUrl ?? null,
        } satisfies Releases;
      });

      const customCache = yield* Cache.make({
        capacity: 256,
        lookup: (key: string) =>
          customLookup(key).pipe(
            Effect.mapError((cause) =>
              cause instanceof DepsError ? cause : failed("custom")(cause),
            ),
          ),
      });

      return Datasources.of({
        lookup: (dependency, custom = {}) => {
          if (dependency.datasource.startsWith("custom.")) {
            const name = dependency.datasource.slice("custom.".length);
            const config = custom[name];

            if (config?.registryUrlTemplate === undefined)
              return Effect.fail(
                new DepsError({
                  message: `no ${dependency.datasource} datasource`,
                }),
              );

            // Renovate fills the URL and transforms as Handlebars templates
            const values = {
              packageName: dependency.packageName,
              currentValue: dependency.currentValue,
            };

            return Cache.get(
              customCache,
              JSON.stringify({
                url: render(config.registryUrlTemplate, values),
                format: config.format,
                transforms: config.transformTemplates.map((transform) =>
                  /\{\{\s*\{?\s*(?:packageName|currentValue)\b/.test(transform)
                    ? render(transform, values)
                    : transform,
                ),
              }),
            );
          }

          return Cache.get(
            cache,
            [
              dependency.datasource,
              dependency.packageName,
              dependency.datasource === "git-refs" ||
              dependency.datasource === "github-tags" ||
              dependency.datasource === "github-releases" ||
              dependency.datasource === "docker"
                ? dependency.currentValue
                : "",
            ].join("\u0000"),
          );
        },
        notes: (dependency, from, to) => {
          const repository = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)/.exec(
            dependency.sourceUrl ?? "",
          )?.[1];

          if (repository === undefined) return Effect.succeed(undefined);

          return Cache.get(
            cache,
            ["github-releases", repository, from].join("\u0000"),
          ).pipe(
            Effect.map((found) =>
              notesBetween(
                repository,
                found.releases,
                dependency.packageName,
                from,
                to,
              ),
            ),
          );
        },
      });
    }),
  );
}
