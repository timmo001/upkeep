/**
 * The skill jobs: run the shared skills repository's own `skill-maintenance`
 * on a worker, so its upkeep runs once, in Upkeep, instead of as a timer on
 * every machine. `skill-consumers` syncs the skill copies the repositories in
 * its `consumers.yml` take, and `skill-updates` checks the skills against
 * their upstreams and tools, pushing the updates that need no review.
 *
 * Each run builds `skill-maintenance` from a clean checkout of the skills
 * repository's default branch, so it always runs the latest pushed version.
 */
import { Api } from "@timmo001/effect-gh";
import { Effect, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { reason } from "../Failure";
import { pushed, summary } from "../Reporter";
import * as RunLog from "../RunLog";
import {
  cacheRoot as bumpCacheRoot,
  checkout,
  commitAndPush,
  run,
} from "./bump";

const User = Schema.Struct({ login: Schema.String });

const RepositoryInfo = Schema.Struct({ default_branch: Schema.String });

/** The fields of `skill-maintenance updates --json` the job reads. */
const UpdateReport = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      state: Schema.String,
      origin: Schema.String,
      storedSha: Schema.NullOr(Schema.String),
      upstreamSha: Schema.NullOr(Schema.String),
      localEdits: Schema.Array(Schema.String),
      release: Schema.optionalKey(Schema.String),
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
  error: Schema.optionalKey(Schema.String),
});

type UpdateItem = (typeof UpdateReport.Type)["skills"][number];

/** The fields of `skill-maintenance skill-reviews --json` the job reads. */
const ReviewReport = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      skill: Schema.String,
      repo: Schema.String,
      state: Schema.String,
      reviewed: Schema.String,
      latest: Schema.NullOr(Schema.String),
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
});

type ReviewItem = (typeof ReviewReport.Type)["items"][number];

export class SkillMaintenanceFailed extends Schema.TaggedError<SkillMaintenanceFailed>()(
  "SkillMaintenanceFailed",
  { command: Schema.String, exitCode: Schema.Number },
) {
  override get message() {
    return `skill-maintenance ${this.command} exited with ${this.exitCode}`;
  }
}

export class SkillsNeedAgent extends Schema.TaggedError<SkillsNeedAgent>()(
  "SkillsNeedAgent",
  { work: Schema.Array(Schema.String) },
) {
  override get message() {
    return `${this.work.length} skill ${this.work.length === 1 ? "change needs" : "changes need"} an agent: ${this.work.join("; ")}`;
  }
}

/**
 * A clean checkout of the signed-in account's skills repository with
 * `skill-maintenance` built in it. Returns the checkout and the binary.
 */
const build = Effect.fnUntraced(function* () {
  const path = yield* Path.Path;
  const root = path.join(path.dirname(yield* bumpCacheRoot), "skills");
  const { login } = yield* Api.json({ endpoint: "user", method: "GET" }, User);
  const repo = `${login}/skills`;

  const info = yield* Api.json(
    { endpoint: `repos/${repo}`, method: "GET" },
    RepositoryInfo,
  );

  const directory = path.join(root, repo);
  const options = { cwd: directory, trusted: root };

  yield* checkout(repo, info.default_branch, directory, root);
  yield* run(
    "mise",
    ["exec", "--", "bun", "install", "--frozen-lockfile"],
    options,
  );
  yield* run("mise", ["exec", "--", "bun", "run", "build"], options);
  yield* RunLog.info(`Built skill-maintenance from ${repo}`);

  return {
    repo,
    branch: info.default_branch,
    directory,
    root,
    binary: path.join(directory, "dist", "skill-maintenance"),
  };
});

type Built = Effect.Success<ReturnType<typeof build>>;

/**
 * Run `skill-maintenance` in the checkout, writing its output to the run's
 * log as it goes, stdout as info and stderr as warnings. With `capture`,
 * stdout is kept and returned instead, for a JSON report. Returns its exit
 * code, the last `[RESULT]` line it printed, if any, and what it captured.
 */
const maintain = Effect.fnUntraced(function* (
  built: Built,
  args: ReadonlyArray<string>,
  options: { readonly capture?: boolean } = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const captured: Array<string> = [];
  let result: string | undefined;

  const lines = (
    stream: Stream.Stream<Uint8Array, unknown>,
    write: (line: string) => Effect.Effect<void, never, RunLog.RunLog>,
  ) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        if (line.startsWith("[RESULT] ")) result = line.slice(9);

        return line.trim() === "" ? Effect.void : write(line);
      }),
    );

  const exitCode = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(built.binary, [...args], {
          cwd: built.directory,
          stdin: "ignore",
          extendEnv: true,
          env: {
            MISE_TRUSTED_CONFIG_PATHS: built.root,
            MISE_YES: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
        }),
      );

      const [, , code] = yield* Effect.all(
        [
          options.capture === true
            ? handle.stdout.pipe(
                Stream.decodeText(),
                Stream.runForEach((text) =>
                  Effect.sync(() => captured.push(text)),
                ),
              )
            : lines(handle.stdout, RunLog.info),
          lines(handle.stderr, RunLog.warn),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );

      return Number(code);
    }),
  );

  return { exitCode, result, stdout: captured.join("") };
});

/** Run a `--json` report command and decode what it prints. */
const report = Effect.fnUntraced(function* <A>(
  built: Built,
  args: ReadonlyArray<string>,
  schema: Schema.Decoder<A>,
) {
  const { exitCode, stdout } = yield* maintain(built, args, { capture: true });

  if (exitCode !== 0)
    return yield* new SkillMaintenanceFailed({
      command: args.join(" "),
      exitCode,
    });

  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
    stdout,
  );
});

/** Sync the skill copies of every repository listed in `consumers.yml`. */
export const skillConsumers = Effect.fnUntraced(function* () {
  const built = yield* build();
  const { exitCode } = yield* maintain(built, ["consumers"]);

  if (exitCode !== 0)
    return yield* new SkillMaintenanceFailed({
      command: "consumers",
      exitCode,
    });

  yield* summary("Synced the shared skills into their consumers");
});

/** `owner/name` of a GitHub origin URL. */
const originRepo = (origin: string) =>
  origin.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\//)?.[1] ?? null;

/** An import whose upstream moved and that has no local edits to keep. */
const clean = (item: UpdateItem) =>
  item.state === "update-available" ||
  (item.state === "up-to-date" &&
    item.localEdits.length === 0 &&
    item.upstreamSha !== null &&
    item.upstreamSha !== item.storedSha);

/** Only the pinned SHA moves, with nothing in the skill itself changing. */
const shaOnly = (item: UpdateItem) => item.state === "up-to-date";

/** One tool release: the imports it moves and the skills reviewed against it. */
interface ReleaseGroup {
  readonly repo: string;
  readonly tag: string;
  readonly imports: Array<UpdateItem>;
  readonly reviews: Array<ReviewItem>;
}

/**
 * Group the imports that follow a repository's releases with the skills
 * reviewed against that repository, by release, so a release moves together.
 */
const releaseGroups = (
  imports: ReadonlyArray<UpdateItem>,
  reviews: ReadonlyArray<ReviewItem>,
) => {
  const groups = new Map<string, ReleaseGroup>();

  const group = (repo: string, tag: string) => {
    const key = `${repo.toLowerCase()}@${tag}`;
    const found = groups.get(key) ?? { repo, tag, imports: [], reviews: [] };

    groups.set(key, found);

    return found;
  };

  for (const item of imports) {
    const repo = originRepo(item.origin);

    if (item.release !== undefined && repo !== null)
      group(repo, item.release).imports.push(item);
  }

  for (const item of reviews) {
    const key = `${item.repo.toLowerCase()}@${item.latest}`;

    groups.get(key)?.reviews.push(item);
  }

  return [...groups.values()];
};

/**
 * Apply the clean imports through `skill-maintenance updates --update`,
 * validate the repository, then commit and push. A failure resets the
 * checkout and is returned, so the import can go to an agent instead.
 */
const land = Effect.fnUntraced(function* (
  built: Built,
  names: ReadonlyArray<string>,
  subject: string,
) {
  const options = { cwd: built.directory, trusted: built.root };

  return yield* Effect.gen(function* () {
    for (const name of names) {
      const args = [
        "updates",
        "--update",
        "--skill",
        name,
        "--no-commit",
        "--skip-review",
      ];

      const { exitCode } = yield* maintain(built, args);

      if (exitCode !== 0)
        return yield* new SkillMaintenanceFailed({
          command: args.join(" "),
          exitCode,
        });
    }

    yield* run("mise", ["run", "validate"], options);
    yield* run("git", ["add", "--all"], options);

    if ((yield* run("git", ["status", "--porcelain"], options)).trim() === "")
      return undefined;

    const sha = yield* commitAndPush(subject, built.branch, options);

    yield* pushed(built.repo, sha, subject);
    yield* RunLog.info(`Pushed ${subject}`);

    return undefined;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const why = reason(cause);

        yield* RunLog.warn(`${subject}: ${why}`);
        yield* run("git", ["reset", "--quiet", "--hard", "HEAD"], options);
        yield* run("git", ["clean", "--quiet", "-fd"], options);

        return why;
      }),
    ),
  );
});

/**
 * Check the shared skills against their upstreams and the tools they cover.
 * Imports with nothing to review are applied, validated and pushed straight
 * to the default branch, with the imports one tool release moves landing
 * together. What needs an agent, such as merging upstream changes into local
 * edits or reviewing a skill against a new tool release, fails the run and
 * is listed.
 */
export const skillUpdates = Effect.fnUntraced(function* () {
  const built = yield* build();

  const updates = yield* report(built, ["updates", "--json"], UpdateReport);

  if (updates.error !== undefined)
    return yield* new SkillMaintenanceFailed({
      command: `updates --json: ${updates.error}`,
      exitCode: 0,
    });

  const reviews = (yield* report(
    built,
    ["skill-reviews", "--json"],
    ReviewReport,
  )).items.filter((item) => item.state !== "up-to-date");

  const imports = updates.skills.filter(
    (item) => item.state !== "up-to-date" || clean(item),
  );

  const work: Array<string> = [];
  const landed: Array<string> = [];
  const grouped = new Set<object>();

  for (const group of releaseGroups(imports, reviews)) {
    for (const item of [...group.imports, ...group.reviews]) grouped.add(item);

    const label = `${group.repo} ${group.tag}`;

    if (group.reviews.length > 0 || !group.imports.every(clean)) {
      work.push(`${label}: release to bring in`);

      continue;
    }

    const subject = `Update ${group.repo} to ${group.tag}`;

    const failed = yield* land(
      built,
      group.imports.map((item) => item.name),
      subject,
    );

    if (failed === undefined) landed.push(subject);
    else work.push(`${label}: ${failed}`);
  }

  for (const item of imports) {
    if (grouped.has(item)) continue;

    if (!clean(item)) {
      work.push(
        item.state === "manual-review"
          ? `${item.name}: upstream changes to merge with its local edits`
          : `${item.name}: ${item.state}${item.reason === undefined ? "" : `, ${item.reason}`}`,
      );

      continue;
    }

    const subject = shaOnly(item)
      ? `[SHA-only] Update ${item.name}`
      : `Update skill: ${item.name}`;

    const failed = yield* land(built, [item.name], subject);

    if (failed === undefined) landed.push(subject);
    else work.push(`${item.name}: ${failed}`);
  }

  for (const item of reviews) {
    if (grouped.has(item)) continue;

    work.push(
      item.state === "error"
        ? `${item.skill}: couldn't read ${item.repo}'s releases${item.reason === undefined ? "" : `, ${item.reason}`}`
        : `${item.skill}: review against ${item.repo} ${item.latest ?? ""}`.trimEnd(),
    );
  }

  yield* summary(
    landed.length === 0
      ? `No updates to push, ${work.length} for an agent`
      : `Pushed ${landed.join(", ")}; ${work.length} for an agent`,
  );

  if (work.length > 0) return yield* new SkillsNeedAgent({ work });
});
