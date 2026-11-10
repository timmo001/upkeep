/**
 * The skill-change job: an agent changes a skill in a worktree of its own,
 * and what it commits is held on the server as a patch for your approval
 * rather than pushed. The patch, not the worktree, is what counts, so any
 * worker can land it, or start it again from where it got to, when the one
 * that ran the agent is down. Its session and worktree are only for resuming
 * it there, and go once the change has landed or been dropped.
 */
import { Api } from "@timmo001/effect-gh";
import type { Api as UpkeepApi, Domain } from "@upkeep/api";
import {
  Config,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Schedule,
  Schema,
} from "effect";
import { reason as why } from "../Failure";
import * as Lane from "../Lane";
import * as Names from "../Names";
import { attention, pushed, Reporter, summary } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { skipped } from "../Worker";
import * as Worktrees from "../Worktrees";
import { AgentFailed, createSession, lastWords } from "./agent";
import { miseTasks, run, usesMise } from "./bump";

const RepositoryInfo = Schema.Struct({ default_branch: Schema.String });

type Options = { readonly cwd: string; readonly trusted: string };

type Start = Extract<Domain.Command, { readonly kind: "skill-start" }>;

type Revise = Extract<Domain.Command, { readonly kind: "skill-revise" }>;

type OpenAgent = Extract<Domain.Command, { readonly kind: "skill-open" }>;

/** The states in which a change is still being worked on or decided. */
export const open: ReadonlySet<Domain.SkillChangeState> = new Set([
  "working",
  "waiting",
  "applying",
  "stale",
]);

/** Where the patches being applied and the briefs of opened agents go. */
const cache = Config.String("XDG_CACHE_HOME").pipe(
  Config.orElse(() =>
    Config.String("HOME").pipe(Config.map((home) => `${home}/.cache`)),
  ),
  Config.map((root) => `${root}/upkeep/skills`),
);

/** A change's patch, written to a file for `git am` and removed after. */
const patchFile = <A, E, R>(
  id: string,
  patch: string,
  use: (file: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const folder = `${yield* cache}/patches`;
    const file = `${folder}/${id}.patch`;

    yield* fs.makeDirectory(folder, { recursive: true });
    yield* fs.writeFileString(file, patch);

    return yield* use(file).pipe(
      Effect.ensuring(fs.remove(file).pipe(Effect.ignore)),
    );
  });

/** The repository's default branch. */
const defaultBranch = (repo: string) =>
  Api.json({ endpoint: `repos/${repo}`, method: "GET" }, RepositoryInfo).pipe(
    Effect.map(({ default_branch }) => default_branch),
  );

/** `git` lines a patch changes, leaving out its file headers. */
const changedLines = (patch: string) => {
  const files = new Set<string>();
  const lines: Array<string> = [];
  let inHunk = false;

  for (const line of patch.split("\n")) {
    const file = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);

    if (file !== null) {
      files.add(file[1] ?? "");
      files.add(file[2] ?? "");
      inHunk = false;
    } else if (line.startsWith("@@")) inHunk = true;
    else if (/^-- ?$/.test(line)) inHunk = false;
    else if (inHunk && /^[+-]/.test(line)) lines.push(line);
  }

  return { files, lines };
};

/** Where pins live: `skills.yml`, and the marketplace generated from it. */
const pinFiles = new Set(["skills.yml", ".claude-plugin/marketplace.json"]);

/**
 * A change that only moves pins in `skills.yml`, the tags skills were
 * reviewed against or the upstream SHAs they import, and the same SHAs in
 * the generated marketplace, which needs no review.
 */
export const isTagOnly = (patch: string) => {
  const { files, lines } = changedLines(patch);

  return (
    files.has("skills.yml") &&
    [...files].every((file) => pinFiles.has(file)) &&
    lines.length > 0 &&
    lines.every((line) =>
      /^[+-]\s+(?:reviewed: "[^"]+"|upstreamSha: [0-9a-f]{40}|"sha": "[0-9a-f]{40}",?)$/.test(
        line,
      ),
    )
  );
};

/** What the agent is asked to do for each kind of work. */
const task = (start: Pick<Start, "work" | "skills" | "reason">) => {
  const names = start.skills.map((name) => `\`${name}\``).join(", ");

  switch (start.work) {
    case "merge":
      return `Upstream changed ${names}, which this repository keeps local edits to: ${start.reason}. Bring the upstream changes in up to the new SHA, keeping the local edits, and move the pin in skills.yml, following the repository's AGENTS.md for how imports are updated.`;
    case "review":
      return `A tool ${names} covers has a new release: ${start.reason}. Read its release notes since the reviewed tag, change the skill where what it says no longer holds, and record the review with \`mise exec -- bun src/index.ts skill-reviews --reviewed <skill>\`.`;
    case "release":
      return `One tool release moves ${names} together: ${start.reason}. Bring each import up to the release, keeping any local edits, review each skill that covers the tool against the release notes since its reviewed tag, and record each review with \`mise exec -- bun src/index.ts skill-reviews --reviewed <skill>\`, all in one commit.`;
    case "request":
      return `You were asked to change ${names}: ${start.reason}`;
  }
};

const rules = [
  "Work only in this checkout. Run `mise run validate`, or `mise run check` where there's no validate task, until it passes, then commit everything as one commit with a short subject in the repository's style, such as `Update skill: <name>`.",
  "Don't push and don't open a pull request: the commit is held for approval. When nothing needs changing, commit nothing.",
  "End with a short summary of what you changed and why, for someone reading it cold.",
];

const prompt = (start: Pick<Start, "work" | "skills" | "reason">) =>
  [task(start), "", ...rules].join("\n");

/** The settings a skill change's agent runs with. */
const agentSettings = Effect.gen(function* () {
  const settings = yield* Settings.load();
  const agent = settings.skills?.agent ?? settings.heal?.agents?.[0];

  if (agent === undefined)
    return yield* new AgentFailed({
      message: "This worker has no skills.agent or heal.agents in its settings",
    });

  return {
    agent,
    opencode: settings.heal?.opencode ?? "opencode2",
    minutes: settings.skills?.sessionMinutes ?? 30,
  };
});

/**
 * A clean worktree of the default branch for the change, ready for an agent:
 * the change's own, reset to the tip when it's already there.
 */
const prepare = Effect.fnUntraced(function* (repo: string, id: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const trusted = yield* Worktrees.root;
  const branch = yield* defaultBranch(repo);
  const own = yield* Worktrees.forAgent("skill", false, id.slice(0, 8));

  const directory = yield* Worktrees.checkout(repo, branch, own.place(repo));

  const options = { cwd: directory, trusted };

  // As in a heal, the agent's shell runs in OpenCode's service, which would
  // ask before trusting a new checkout's mise config
  if (yield* usesMise(directory))
    yield* run("mise", ["trust"], { cwd: directory, trusted: "" });

  if (yield* fs.exists(path.join(directory, "bun.lock")))
    yield* run(
      "mise",
      ["exec", "--", "bun", "install", "--frozen-lockfile"],
      options,
    );

  const base = (yield* run("git", ["rev-parse", "HEAD"], options)).trim();

  return { directory, branch, base, options };
});

/** Run the agent in its session, for at most its minutes. */
const work = Effect.fnUntraced(function* (
  opencode: string,
  session: string,
  title: string,
  text: string,
  minutes: number,
  options: Options,
) {
  // The lane is free for the next run once the agent is going
  yield* Lane.release;

  const outcome = yield* run(
    opencode,
    ["run", "--auto", "--session", session, "--title", title, text],
    options,
  ).pipe(
    Effect.as(undefined),
    Effect.catch((error) =>
      Effect.succeed(
        `The agent stopped: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ),
    Effect.timeoutOption(`${minutes} minutes`),
    Effect.map(
      Option.getOrElse(() => `The agent ran out of its ${minutes} minutes`),
    ),
  );

  if (outcome !== undefined) yield* RunLog.warn(outcome);

  return outcome ?? null;
});

/**
 * What the agent committed since `base`, as one commit: anything it left
 * uncommitted is committed, and several commits are squashed under the
 * first one's subject. Null when it changed nothing.
 */
const collect = Effect.fnUntraced(function* (
  base: string,
  title: string,
  options: Options,
) {
  yield* run("git", ["add", "--all"], options);

  if ((yield* run("git", ["status", "--porcelain"], options)).trim() !== "")
    yield* run(
      "git",
      ["commit", "--quiet", "--no-verify", "-m", `Update skill: ${title}`],
      options,
    );

  const subjects = (yield* run(
    "git",
    ["log", "--reverse", "--format=%s", `${base}..HEAD`],
    options,
  ))
    .split("\n")
    .filter((line) => line.trim() !== "");

  const [subject] = subjects;

  if (subject === undefined) return null;

  if (subjects.length > 1) {
    yield* run("git", ["reset", "--quiet", "--soft", base], options);
    yield* run(
      "git",
      ["commit", "--quiet", "--no-verify", "-m", subject],
      options,
    );
  }

  const patch = yield* run(
    "git",
    ["format-patch", "--stdout", `${base}..HEAD`],
    options,
  );

  return { patch, subject };
});

/**
 * Push the checkout's HEAD, rebasing onto the branch when it moved. Skill
 * changes run side by side and often finish together, so the branch can move
 * again between the rebase and the push; that's tried a few more times.
 */
const push = Effect.fnUntraced(function* (branch: string, options: Options) {
  const attempt = run(
    "git",
    ["push", "--quiet", "origin", `HEAD:${branch}`],
    options,
  );

  yield* attempt.pipe(
    Effect.catch(() =>
      run(
        "git",
        ["pull", "--rebase", "--quiet", "origin", branch],
        options,
      ).pipe(
        Effect.andThen(attempt),
        Effect.retry({ schedule: Schedule.exponential("2 seconds"), times: 4 }),
      ),
    ),
  );

  return (yield* run("git", ["rev-parse", "HEAD"], options)).trim();
});

/** The repository's validation: its `validate` task, or else `check`. */
const validate = Effect.fnUntraced(function* (options: Options) {
  if (!(yield* usesMise(options.cwd))) return;

  const tasks = yield* miseTasks(options);
  const task = tasks.includes("validate") ? "validate" : "check";

  if (tasks.includes(task))
    yield* run("mise", ["run", "--force", task], options);
});

/** A change as it's sent to the server, as a plain object to update. */
type Held = {
  readonly [
    K in keyof UpkeepApi.SkillChangeInput
  ]: UpkeepApi.SkillChangeInput[K];
};

/** A held change as the worker sends it back, without its ID, worker or time. */
const toHeld = (change: Domain.SkillChange): Held => ({
  repo: change.repo,
  title: change.title,
  skills: change.skills,
  work: change.work,
  reason: change.reason,
  base: change.base,
  patch: change.patch,
  subject: change.subject,
  summary: change.summary,
  session: change.session,
  directory: change.directory,
  state: change.state,
  commit: change.commit,
  note: change.note,
});

/**
 * Settle what the agent did: nothing to change drops the change, a change
 * to pins alone is pushed straight away, and anything else waits for you.
 */
const settle = Effect.fnUntraced(function* (
  id: string,
  held: Held,
  session: string,
  stopped: string | null,
  setup: Effect.Success<typeof agentSettings>,
  prepared: { readonly branch: string; readonly options: Options },
) {
  const reporter = yield* Reporter;
  const result = yield* collect(held.base ?? "", held.title, prepared.options);

  const said = yield* lastWords(setup.opencode, session, prepared.options).pipe(
    Effect.orElseSucceed(() => null),
  );

  if (result === null) {
    yield* reporter.putSkillChange(id, {
      ...held,
      summary: said,
      state: "dropped",
      note: stopped ?? "The agent changed nothing",
    });
    yield* Worktrees.discard(prepared.options.cwd);

    return yield* summary(`${held.title}: nothing to change`);
  }

  if (isTagOnly(result.patch)) {
    const sha = yield* push(prepared.branch, prepared.options);

    yield* reporter.putSkillChange(id, {
      ...held,
      ...result,
      summary: said,
      state: "landed",
      commit: sha,
      note: null,
    });
    yield* pushed(held.repo, sha, result.subject);
    yield* Worktrees.discard(prepared.options.cwd);

    return yield* summary(`Pushed ${result.subject}, which only moves pins`);
  }

  yield* reporter.putSkillChange(id, {
    ...held,
    ...result,
    summary: said,
    state: "waiting",
    note: stopped,
  });
  yield* attention;
  yield* summary(`${result.subject} is held for your approval`);
});

/**
 * Mark a change stale when its run fails after the agent started, so it
 * isn't left working, and can be started again.
 */
const staleOnFailure =
  (id: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapCause((cause) =>
        Reporter.use((reporter) =>
          reporter.skillChangeState(id, { state: "stale", note: why(cause) }),
        ).pipe(Effect.ignore),
      ),
    );

/** Start an agent on a skill and hold what it commits. */
const start = Effect.fnUntraced(function* (command: Start) {
  const reporter = yield* Reporter;
  const setup = yield* agentSettings;
  const id = crypto.randomUUID();
  const prepared = yield* prepare(command.repo, id);

  const session = yield* createSession(
    setup.opencode,
    setup.agent,
    prepared.options,
  );

  const held: Held = {
    repo: command.repo,
    title: command.title,
    skills: command.skills,
    work: command.work,
    reason: command.reason,
    base: prepared.base,
    patch: null,
    subject: null,
    summary: null,
    session,
    directory: prepared.directory,
    state: "working",
    commit: null,
    note: null,
  };

  yield* reporter.putSkillChange(id, held);
  yield* RunLog.info(
    `Created OpenCode session ${session} in ${prepared.directory}`,
  );

  const stopped = yield* work(
    setup.opencode,
    session,
    command.title,
    prompt(command),
    setup.minutes,
    prepared.options,
  ).pipe(staleOnFailure(id));

  yield* settle(id, held, session, stopped, setup, prepared).pipe(
    staleOnFailure(id),
  );
});

/**
 * Land a held change from a fresh checkout, so any worker can: apply its
 * patch, validate and push. One that no longer applies or validates is
 * marked stale, for you to start again.
 */
const approve = Effect.fnUntraced(function* (id: string) {
  const reporter = yield* Reporter;
  const change = yield* reporter.skillChange(id);

  if (change.state === "landed" || change.state === "dropped") {
    yield* RunLog.info(`${change.title} has already ${change.state}`);

    return skipped;
  }

  if (change.patch === null)
    return yield* new AgentFailed({
      message: `${change.title} has no patch to land yet`,
    });

  yield* reporter.skillChangeState(id, { state: "applying" });

  const patch = change.patch;

  const landed = yield* Effect.gen(function* () {
    const prepared = yield* prepare(change.repo, id);

    yield* patchFile(id, patch, (file) =>
      run("git", ["am", "--3way", "--quiet", file], prepared.options).pipe(
        Effect.tapError(() =>
          run("git", ["am", "--abort"], prepared.options).pipe(Effect.ignore),
        ),
      ),
    );
    yield* validate(prepared.options);

    const sha = yield* push(prepared.branch, prepared.options);

    yield* Worktrees.discard(prepared.directory);

    return sha;
  }).pipe(Effect.exit);

  if (Exit.isFailure(landed)) {
    const note = why(landed.cause);

    yield* reporter.skillChangeState(id, { state: "stale", note });
    yield* attention;

    return yield* summary(`${change.title} is stale: ${note}`);
  }

  yield* reporter.skillChangeState(id, {
    state: "landed",
    commit: landed.value,
  });
  yield* pushed(change.repo, landed.value, change.subject ?? change.title);
  yield* summary(`Landed ${change.subject ?? change.title}`);
});

/**
 * Ask for more on a held change. On the worker it ran on, with its worktree
 * still there, its session goes on; anywhere else, a new session starts from
 * a fresh worktree with the held patch applied.
 */
const revise = Effect.fnUntraced(function* (command: Revise) {
  const fs = yield* FileSystem.FileSystem;
  const reporter = yield* Reporter;
  const setup = yield* agentSettings;
  const change = yield* reporter.skillChange(command.change);
  const trusted = yield* Worktrees.root;
  const resumable = change.session;

  if (
    command.worker !== null &&
    resumable !== null &&
    change.base !== null &&
    (yield* fs.exists(change.directory))
  ) {
    const options = { cwd: change.directory, trusted };
    const branch = yield* defaultBranch(change.repo);

    const held: Held = {
      ...toHeld(change),
      state: "working",
      note: null,
    };

    yield* reporter.putSkillChange(change.id, held);

    const stopped = yield* work(
      setup.opencode,
      resumable,
      change.title,
      [
        `Your change came back from review with this: ${command.comment}`,
        "",
        "Change it to suit, then commit again; amending or a new commit are both fine.",
        ...rules,
      ].join("\n"),
      setup.minutes,
      options,
    ).pipe(staleOnFailure(change.id));

    return yield* settle(change.id, held, resumable, stopped, setup, {
      branch,
      options,
    }).pipe(staleOnFailure(change.id));
  }

  const prepared = yield* prepare(change.repo, change.id);
  let applied = false;

  if (change.patch !== null)
    applied = yield* patchFile(change.id, change.patch, (file) =>
      run("git", ["am", "--3way", "--quiet", file], prepared.options).pipe(
        Effect.as(true),
        Effect.catch(() =>
          run("git", ["am", "--abort"], prepared.options).pipe(
            Effect.ignore,
            Effect.as(false),
          ),
        ),
      ),
    );

  const session = yield* createSession(
    setup.opencode,
    setup.agent,
    prepared.options,
  );

  const held: Held = {
    ...toHeld(change),
    base: prepared.base,
    session,
    directory: prepared.directory,
    state: "working",
    note: null,
  };

  yield* reporter.putSkillChange(change.id, held);
  yield* RunLog.info(
    `Created OpenCode session ${session} in ${prepared.directory}`,
  );

  const earlier =
    change.patch === null
      ? []
      : applied
        ? [
            "An earlier agent made a change for this, applied here as the last commit. What it said:",
            "",
            change.summary ?? "(nothing)",
            "",
          ]
        : [
            "An earlier agent made a change for this that no longer applies, so start from the default branch. What it said:",
            "",
            change.summary ?? "(nothing)",
            "",
          ];

  const stopped = yield* work(
    setup.opencode,
    session,
    change.title,
    [
      task(change),
      "",
      ...earlier,
      `It came back from review with this: ${command.comment}`,
      "",
      ...rules,
    ].join("\n"),
    setup.minutes,
    prepared.options,
  ).pipe(staleOnFailure(change.id));

  yield* settle(change.id, held, session, stopped, setup, prepared).pipe(
    staleOnFailure(change.id),
  );
});

/**
 * Remove the worktrees of changes that have ended, or that the server no
 * longer knows, leaving those still open.
 */
export const prune = Effect.fnUntraced(function* () {
  const reporter = yield* Reporter;

  const kept = new Set(
    (yield* reporter.skillChanges())
      .filter((change) => open.has(change.state))
      .map((change) => change.directory),
  );

  for (const { directory } of yield* Worktrees.agents("skill"))
    if (!kept.has(directory)) yield* Worktrees.discard(directory);
});

/**
 * Open an agent on a held change in its checkout on this worker, through
 * its `attention.launch`, with a brief of where the change stands. Commits
 * made there are part of the change the next time it resumes.
 */
const openAgent = Effect.fnUntraced(function* (command: OpenAgent) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const reporter = yield* Reporter;
  const setup = (yield* Settings.load()).attention?.launch;

  if (setup === undefined)
    return yield* new AgentFailed({
      message: "This worker has no attention.launch in its settings",
    });

  const change = yield* reporter.skillChange(command.change);

  if (!(yield* fs.exists(change.directory)))
    return yield* new AgentFailed({
      message: `${change.title}'s checkout is no longer on this worker`,
    });

  const brief = [
    `# ${change.title}`,
    "",
    `A skill change in ${change.repo}, held on Upkeep's Skills page${change.state === "waiting" ? " for approval" : ` (${change.state})`}. ${change.session === null ? "" : `The agent that made it ran in OpenCode session ${change.session}. `}This checkout has its commit on top of the default branch.`,
    "",
    `What started it: ${change.reason}`,
    "",
    "What the agent said:",
    "",
    change.summary ?? "(nothing)",
    "",
    "Wait for instructions. Don't push: the change lands when it's approved on the Skills page, and what's committed here is part of it once changes are asked for there with Resume.",
  ].join("\n");

  const briefs = path.join(yield* cache, "briefs");
  const file = path.join(briefs, `${change.id}.md`);

  yield* fs.makeDirectory(briefs, { recursive: true });
  yield* fs.writeFileString(file, brief);

  const listed = yield* Names.find(change.repo);

  const fill = (arg: string) =>
    arg
      .replaceAll("{brief}", file)
      .replaceAll("{directory}", change.directory)
      .replaceAll("{repo}", change.repo)
      .replaceAll("{name}", Names.nameOf(change.repo, listed))
      .replaceAll("{title}", change.title);

  const [program = "", ...args] = setup.command.map(fill);

  yield* run(program, args, { cwd: change.directory, trusted: "" });
  yield* summary(`Opened an agent on ${change.title} in ${change.directory}`);
});

export const skillChange = Effect.fnUntraced(function* (
  command: Domain.Command | null,
) {
  switch (command?.kind) {
    case "skill-start":
      return yield* start(command);
    case "skill-approve":
      return yield* approve(command.change);
    case "skill-revise":
      return yield* revise(command);
    case "skill-open":
      return yield* openAgent(command);
    default:
      yield* RunLog.info("No skill change to make");

      return skipped;
  }
});
