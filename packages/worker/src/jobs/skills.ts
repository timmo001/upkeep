/**
 * The skill jobs: run the shared skills repository's own `skill-maintenance`
 * on a worker, so its upkeep runs once, in Upkeep, instead of as a timer on
 * every machine. `skill-consumers` syncs the skill copies the repositories in
 * its `consumers.yml` take, and `skill-updates` checks the skills against
 * their upstreams and tools, pushing the updates that need no review, and
 * sends how each skill stands to the Skills page.
 *
 * Each run builds `skill-maintenance` from a clean checkout of the skills
 * repository's default branch, so it always runs the latest pushed version.
 */
import { Api } from "@timmo001/effect-gh";
import type { Domain } from "@upkeep/api";
import { Clock, Effect, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { reason } from "../Failure";
import { pushed, Reporter, summary } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import {
  cacheRoot as bumpCacheRoot,
  checkout,
  commitAndPush,
  run,
} from "./bump";
import { open, prune } from "./skill-changes";
import { other as otherSkills, send, shared } from "./skill-snapshots";

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

export class SkillUpdateProblems extends Schema.TaggedError<SkillUpdateProblems>()(
  "SkillUpdateProblems",
  { problems: Schema.Array(Schema.String) },
) {
  override get message() {
    return `${this.problems.length} skill ${this.problems.length === 1 ? "update needs" : "updates need"} looking at: ${this.problems.join("; ")}`;
  }
}

type Start = Extract<Domain.Command, { readonly kind: "skill-start" }>;

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

    // `--update` moves the pins in skills.yml but leaves the generated
    // marketplace pinned to the old SHAs, which validation rejects as stale
    const catalogue = yield* maintain(built, ["catalogue"]);

    if (catalogue.exitCode !== 0)
      return yield* new SkillMaintenanceFailed({
        command: "catalogue",
        exitCode: catalogue.exitCode,
      });

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
 * edits or reviewing a skill against a new tool release, starts a run of the
 * skill-change job, which holds the agent's change for your approval.
 */
export const skillUpdates = Effect.fnUntraced(function* () {
  const built = yield* build();

  const updates = yield* report(built, ["updates", "--json"], UpdateReport);

  if (updates.error !== undefined)
    return yield* new SkillMaintenanceFailed({
      command: `updates --json: ${updates.error}`,
      exitCode: 0,
    });

  const checked = (yield* report(
    built,
    ["skill-reviews", "--json"],
    ReviewReport,
  )).items;

  const reviews = checked.filter((item) => item.state !== "up-to-date");

  const imports = updates.skills.filter(
    (item) => item.state !== "up-to-date" || clean(item),
  );

  const starts: Array<Start> = [];
  const problems: Array<string> = [];
  const landed: Array<string> = [];
  const grouped = new Set<object>();

  const hold = (
    title: string,
    skills: ReadonlyArray<string>,
    work: Domain.SkillWork,
    why: string,
  ) =>
    starts.push({
      kind: "skill-start",
      repo: built.repo,
      title,
      skills,
      work,
      reason: why,
    });

  const moved = (item: UpdateItem) =>
    `${item.name} ${item.storedSha?.slice(0, 7) ?? "unpinned"} to ${item.upstreamSha?.slice(0, 7) ?? "unknown"} from ${item.origin}${item.localEdits.length === 0 ? "" : `, with local edits to ${item.localEdits.join(", ")}`}`;

  const reviewed = (item: ReviewItem) =>
    `${item.skill} reviewed against ${item.repo} ${item.reviewed}, now ${item.latest ?? "unknown"}`;

  for (const group of releaseGroups(imports, reviews)) {
    for (const item of [...group.imports, ...group.reviews]) grouped.add(item);

    const label = `${group.repo} ${group.tag}`;

    const release = (failed?: string) =>
      hold(
        label,
        [
          ...group.imports.map((item) => item.name),
          ...group.reviews.map((item) => item.skill),
        ],
        "release",
        [
          ...group.imports.map(moved),
          ...group.reviews.map(reviewed),
          ...(failed === undefined
            ? []
            : [`applying it alone failed: ${failed}`]),
        ].join("; "),
      );

    if (group.reviews.length > 0 || !group.imports.every(clean)) {
      release();

      continue;
    }

    const subject = `Update ${group.repo} to ${group.tag}`;

    const failed = yield* land(
      built,
      group.imports.map((item) => item.name),
      subject,
    );

    if (failed === undefined) landed.push(subject);
    else release(failed);
  }

  for (const item of imports) {
    if (grouped.has(item)) continue;

    if (!clean(item)) {
      if (item.state === "manual-review")
        hold(item.name, [item.name], "merge", moved(item));
      else
        problems.push(
          `${item.name}: ${item.state}${item.reason === undefined ? "" : `, ${item.reason}`}`,
        );

      continue;
    }

    const subject = shaOnly(item)
      ? `[SHA-only] Update ${item.name}`
      : `Update skill: ${item.name}`;

    const failed = yield* land(built, [item.name], subject);

    if (failed === undefined) landed.push(subject);
    else
      hold(
        item.name,
        [item.name],
        "merge",
        `${moved(item)}; applying it alone failed: ${failed}`,
      );
  }

  for (const item of reviews) {
    if (grouped.has(item)) continue;

    if (item.state === "error")
      problems.push(
        `${item.skill}: couldn't read ${item.repo}'s releases${item.reason === undefined ? "" : `, ${item.reason}`}`,
      );
    else hold(item.skill, [item.skill], "review", reviewed(item));
  }

  const queued = yield* queue(starts);

  yield* prune().pipe(
    Effect.catchCause((cause) =>
      RunLog.warn(
        `Couldn't tidy the held changes' checkouts: ${reason(cause)}`,
      ),
    ),
  );

  yield* send(
    shared(
      built.repo,
      { cwd: built.directory, trusted: built.root },
      updates.skills,
      checked,
    ),
  );

  const settings = yield* Settings.load();

  for (const other of settings.skills?.repos ?? [])
    yield* send(otherSkills(other.repo, other.path, built.root));

  yield* summary(
    [
      landed.length === 0
        ? "No updates to push"
        : `Pushed ${landed.join(", ")}`,
      `${queued} started for an agent`,
      ...(starts.length > queued
        ? [`${starts.length - queued} already held`]
        : []),
    ].join("; "),
  );

  if (problems.length > 0) return yield* new SkillUpdateProblems({ problems });
});

/**
 * Hand each piece of work to an agent through the skill-change job, unless
 * a change for it is still open. One stuck working for over two hours, such
 * as on a worker that went down, doesn't count. Returns how many started.
 */
const queue = Effect.fnUntraced(function* (starts: ReadonlyArray<Start>) {
  if (starts.length === 0) return 0;

  const reporter = yield* Reporter;
  const now = yield* Clock.currentTimeMillis;
  const changes = yield* reporter.skillChanges();

  const busy = new Set(
    changes
      .filter(
        (change) =>
          open.has(change.state) &&
          !(change.state === "working" && now - change.at > 2 * 3_600_000),
      )
      .map((change) => `${change.repo.toLowerCase()} ${change.title}`),
  );

  let queued = 0;

  for (const start of starts) {
    if (busy.has(`${start.repo.toLowerCase()} ${start.title}`)) continue;

    yield* reporter.skillCommand(start);
    yield* RunLog.info(`Started an agent on ${start.title}: ${start.reason}`);
    queued += 1;
  }

  return queued;
});
