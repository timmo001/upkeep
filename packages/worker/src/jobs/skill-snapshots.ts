/**
 * What the Skills page shows of each repository's skills: where each comes
 * from, how it stands against its upstream and the tools it covers, which
 * repositories keep a copy and its last commits. `skill-updates` reads it
 * from its checkouts once it's done and sends it to the server.
 */
import { Api } from "@timmo001/effect-gh";
import type { Domain } from "@upkeep/api";
import { Clock, Effect, FileSystem, Path, Schema } from "effect";
import { Yaml } from "effect/encoding";
import { reason } from "../Failure";
import { Reporter } from "../Reporter";
import * as RunLog from "../RunLog";
import type * as Worktrees from "../Worktrees";
import { run } from "./bump";

const RepositoryInfo = Schema.Struct({ default_branch: Schema.String });

const Frontmatter = Schema.Struct({ description: Schema.String });

const Manifest = Schema.Struct({
  skills: Schema.Record(
    Schema.String,
    Schema.Struct({
      import: Schema.optionalKey(
        Schema.Struct({
          origin: Schema.String,
          localEdits: Schema.optionalKey(Schema.Array(Schema.String)),
          distribution: Schema.optionalKey(Schema.String),
        }),
      ),
      tools: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({ repo: Schema.String, reviewed: Schema.String }),
        ),
      ),
    }),
  ),
});

const Consumers = Schema.Struct({
  repositories: Schema.Record(
    Schema.String,
    Schema.Struct({ skills: Schema.Array(Schema.String) }),
  ),
});

/** An import as `skill-maintenance updates --json` reports it. */
export interface Upstream {
  readonly name: string;
  readonly state: string;
  readonly storedSha: string | null;
  readonly upstreamSha: string | null;
  readonly release?: string;
}

/** A tool review as `skill-maintenance skill-reviews --json` reports it. */
export interface Review {
  readonly skill: string;
  readonly repo: string;
  readonly reviewed: string;
  readonly latest: string | null;
  readonly state: string;
}

type Options = { readonly cwd: string; readonly trusted: string };

/** A YAML file in the checkout, decoded, or undefined when it's not there. */
const readYaml = Effect.fnUntraced(function* <A>(
  file: string,
  schema: Schema.Decoder<A>,
) {
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* fs.exists(file))) return undefined;

  const text = yield* fs.readFileString(file);

  return yield* Effect.try(() => Yaml.parse(text)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
  );
});

/** The `description` in a SKILL.md's frontmatter, or empty without one. */
const description = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* fs.exists(file))) return "";

  const text = yield* fs.readFileString(file);
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];

  if (frontmatter === undefined) return "";

  return yield* Effect.try(() => Yaml.parse(frontmatter)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Frontmatter)),
    Effect.map((parsed) => parsed.description),
    Effect.orElseSucceed(() => ""),
  );
});

/** The last five commits touching a folder, newest first. */
const commits = Effect.fnUntraced(function* (folder: string, options: Options) {
  const log = yield* run(
    "git",
    ["log", "-5", "--format=%H%x1f%s%x1f%ct", "--", folder],
    options,
  );

  return log
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [sha = "", subject = "", at = "0"] = line.split("\x1f");

      return { sha, subject, at: Number(at) * 1000 };
    });
});

/** The folders under `folder` that hold a SKILL.md. */
const skillFolders = Effect.fnUntraced(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!(yield* fs.exists(folder))) return [];

  const entries = yield* fs.readDirectory(folder);

  return yield* Effect.filter(entries, (entry) =>
    fs
      .exists(path.join(folder, entry, "SKILL.md"))
      .pipe(Effect.orElseSucceed(() => false)),
  );
});

/** Each skill in a folder of the checkout, with nothing but its own files. */
const authored = Effect.fnUntraced(function* (
  folder: string,
  options: Options,
  names: ReadonlyArray<string>,
) {
  const path = yield* Path.Path;

  return yield* Effect.forEach(
    names,
    Effect.fnUntraced(function* (name) {
      const relative = path.join(folder, name);

      const info: Domain.SkillInfo = {
        name,
        description: yield* description(
          path.join(options.cwd, relative, "SKILL.md"),
        ),
        source: "authored",
        origin: null,
        upstream: null,
        localEdits: [],
        tools: [],
        copies: [],
        commits: yield* commits(relative, options),
      };

      return info;
    }),
    { concurrency: 8 },
  );
});

/**
 * The shared skills repository's skills, from its `skills.yml` and
 * `consumers.yml` and the two reports `skill-updates` read.
 */
export const shared = Effect.fnUntraced(function* (
  repo: string,
  options: Options,
  upstreams: ReadonlyArray<Upstream>,
  reviews: ReadonlyArray<Review>,
) {
  const path = yield* Path.Path;

  const manifest =
    (yield* readYaml(path.join(options.cwd, "skills.yml"), Manifest))?.skills ??
    {};

  const consumers =
    (yield* readYaml(path.join(options.cwd, "consumers.yml"), Consumers))
      ?.repositories ?? {};

  const names = [
    ...new Set([
      ...(yield* skillFolders(options.cwd)),
      ...Object.keys(manifest),
    ]),
  ].sort();

  const base = yield* authored("", options, names);

  const skills = base.map((skill): Domain.SkillInfo => {
    const entry = manifest[skill.name];
    const imported = entry?.import;
    const upstream = upstreams.find((item) => item.name === skill.name);
    const localEdits = imported?.localEdits ?? [];
    const reviewed = reviews.filter((item) => item.skill === skill.name);

    return {
      name: skill.name,
      description: skill.description,
      commits: skill.commits,
      source:
        imported === undefined
          ? "authored"
          : imported.distribution === "external"
            ? "external"
            : localEdits.length > 0
              ? "adapted"
              : "imported",
      origin: imported?.origin ?? null,
      upstream:
        upstream === undefined
          ? null
          : {
              state: upstream.state,
              storedSha: upstream.storedSha,
              upstreamSha: upstream.upstreamSha,
              release: upstream.release ?? null,
            },
      localEdits,
      tools:
        reviewed.length > 0
          ? reviewed.map((item) => ({
              repo: item.repo,
              reviewed: item.reviewed,
              latest: item.latest,
              state: item.state,
            }))
          : (entry?.tools ?? []).map((tool) => ({
              ...tool,
              latest: null,
              state: "unknown",
            })),
      copies: Object.entries(consumers)
        .filter(([, consumer]) => consumer.skills.includes(skill.name))
        .map(([name]) => name)
        .sort(),
    };
  });

  return { repo, skills };
});

/**
 * The skills in another repository's folder, from the run's worktree of its
 * default branch.
 */
export const other = Effect.fnUntraced(function* (
  repo: string,
  folder: string,
  worktrees: Worktrees.Run,
) {
  const path = yield* Path.Path;

  const { default_branch: branch } = yield* Api.json(
    { endpoint: `repos/${repo}`, method: "GET" },
    RepositoryInfo,
  );

  const directory = yield* worktrees.checkout(repo, branch);
  const options = { cwd: directory, trusted: worktrees.trusted };
  const names = (yield* skillFolders(path.join(directory, folder))).sort();

  return { repo, skills: yield* authored(folder, options, names) };
});

/**
 * Send a repository's skills to the server once read. One that can't be read
 * or sent is logged, so the page going stale never fails the run.
 */
export const send = <R>(
  read: Effect.Effect<
    { readonly repo: string; readonly skills: ReadonlyArray<Domain.SkillInfo> },
    unknown,
    R
  >,
) =>
  read.pipe(
    Effect.flatMap(
      Effect.fnUntraced(function* ({ repo, skills }) {
        const reporter = yield* Reporter;

        yield* reporter.putSkills({
          repo,
          skills,
          checkedAt: yield* Clock.currentTimeMillis,
        });
        yield* RunLog.info(`Sent ${skills.length} skills in ${repo}`);
      }),
    ),
    Effect.catchCause((cause) =>
      RunLog.warn(
        `Couldn't read the skills for the Skills page: ${reason(cause)}`,
      ),
    ),
  );
