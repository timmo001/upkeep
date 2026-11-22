/**
 * The branch-drift job: keep the branches that follow another in step with
 * it. A branch opts in with a `.dot-branch.yml` at its root, naming its mode
 * and, to be rebased, the branch it follows. When one is behind, an agent
 * rebases it in a worktree of its own, following the branch's AGENTS.md, and
 * the worker checks the result and pushes it with a lease, so a branch that
 * moved meanwhile is left alone. Parents go first, and a branch waits while
 * its parent isn't in step, so it's only ever rebased onto a parent that is.
 * One an agent couldn't finish keeps its worktree and session for you, and
 * is skipped until it's in step again.
 */
import { Api, GhCommandError } from "@timmo001/effect-gh";
import { Catalogue, EventJobs } from "@upkeep/api";
import { Effect, FileSystem, Option, Path, Result, Schema } from "effect";
import { Yaml } from "effect/encoding";
import { reason } from "../Failure";
import * as Lane from "../Lane";
import { attention, pushed, summary, trackedRepos } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { skipped } from "../Worker";
import * as Worktrees from "../Worktrees";
import { AgentFailed, createSession, lastWords } from "./agent";
import { run, usesMise } from "./bump";

/** The file at a branch's root that says how it's kept in step. */
export const branchFile = EventJobs.branchFile;

/**
 * How a branch is kept: `own` leaves it alone, and `rebase` keeps it on top
 * of `parent`. Commits on the parent that only touch `ignore` don't count as
 * behind, such as a page the branch regenerates itself.
 */
export const BranchFile = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("own") }),
  Schema.Struct({
    mode: Schema.Literal("rebase"),
    parent: Schema.String.check(Schema.isMinLength(1)),
    ignore: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
]);

export type BranchFile = typeof BranchFile.Type;

const Branch = Schema.Struct({ name: Schema.String });

/** A branch kept on top of its parent. */
export interface Managed {
  readonly branch: string;
  readonly parent: string;
  readonly ignore: ReadonlyArray<string>;
}

/** What became of a branch in a run. Only `in-step` and `rebased` let its children go on. */
export type Outcome =
  | { readonly kind: "in-step" }
  | { readonly kind: "rebased"; readonly behind: number }
  | { readonly kind: "waiting"; readonly on: string }
  | { readonly kind: "busy" }
  | { readonly kind: "moved" }
  | { readonly kind: "needs-you"; readonly note: string };

type Options = { readonly cwd: string; readonly trusted: string };

/**
 * The branches to rebase, parents first, and those that can't be: a parent
 * that isn't a branch, or parents that loop.
 */
export const inOrder = (
  files: ReadonlyMap<string, BranchFile>,
  branches: ReadonlySet<string>,
) => {
  const managed = new Map<string, Managed>();

  for (const [branch, file] of files)
    if (file.mode === "rebase")
      managed.set(branch, {
        branch,
        parent: file.parent,
        ignore: file.ignore ?? [],
      });

  const depthOf = (
    branch: string,
    seen: ReadonlySet<string>,
  ): number | undefined => {
    const entry = managed.get(branch);

    if (entry === undefined) return 0;

    if (seen.has(branch)) return undefined;

    const parent = depthOf(entry.parent, new Set([...seen, branch]));

    return parent === undefined ? undefined : parent + 1;
  };

  const ordered: Array<Managed & { readonly depth: number }> = [];
  const problems = new Map<string, string>();

  for (const entry of managed.values()) {
    const depth = depthOf(entry.branch, new Set());

    if (!branches.has(entry.parent))
      problems.set(entry.branch, `its parent ${entry.parent} isn't a branch`);
    else if (depth === undefined)
      problems.set(entry.branch, `its parents loop back to it`);
    else ordered.push({ ...entry, depth });
  }

  return {
    order: ordered
      .toSorted((a, b) => a.depth - b.depth || a.branch.localeCompare(b.branch))
      .map(({ branch, parent, ignore }) => ({ branch, parent, ignore })),
    problems,
  };
};

/**
 * Keep each branch in order, parents first. One whose parent didn't end in
 * step waits, and holds its own children back the same way.
 */
export const walk = <E, R>(
  order: ReadonlyArray<Managed>,
  held: ReadonlySet<string>,
  keep: (entry: Managed) => Effect.Effect<Outcome, E, R>,
) =>
  Effect.gen(function* () {
    const holding = new Set(held);
    const outcomes: Array<readonly [string, Outcome]> = [];

    for (const entry of order) {
      const outcome: Outcome = holding.has(entry.parent)
        ? { kind: "waiting", on: entry.parent }
        : yield* keep(entry);

      if (outcome.kind !== "in-step" && outcome.kind !== "rebased")
        holding.add(entry.branch);

      outcomes.push([entry.branch, outcome]);
    }

    return outcomes;
  });

/** The branches an agent of this worker is rebasing now, by repository. */
const working = new Set<string>();

const missing = (cause: unknown) =>
  cause instanceof GhCommandError && /\b404\b|Not Found/.test(cause.stderr);

/** A branch's file through the GitHub API, none when it has none. */
const readBranchFile = (repo: string, branch: string) =>
  Api.text({
    endpoint: `repos/${repo}/contents/${branchFile}`,
    method: "GET",
    headers: { Accept: "application/vnd.github.raw+json" },
    query: { ref: branch },
  }).pipe(
    Effect.map(Option.some),
    Effect.catchIf(missing, () => Effect.succeed(Option.none<string>())),
  );

const decode = (text: string) =>
  Effect.try({
    try: () => Yaml.parse(text),
    catch: (cause) => `isn't valid YAML: ${String(cause)}`,
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(BranchFile)(value).pipe(
        Effect.mapError(
          (cause) => `doesn't match the expected shape: ${String(cause)}`,
        ),
      ),
    ),
  );

/** Fetch a branch's tip into `origin/<branch>`. */
const fetch = (branch: string, options: Options) =>
  run(
    "git",
    [
      "fetch",
      "--quiet",
      "--no-write-fetch-head",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ],
    options,
  );

const revParse = (rev: string, options: Options) =>
  run("git", ["rev-parse", "--verify", "--quiet", rev], options).pipe(
    Effect.map((sha) => sha.trim()),
  );

/** Whether `ancestor` is in `rev`'s history. */
const contains = (ancestor: string, rev: string, options: Options) =>
  run("git", ["merge-base", "--is-ancestor", ancestor, rev], options).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

/** Whether a checkout of the repository on this machine is part way through rebasing the branch. */
const rebasing = Effect.fnUntraced(function* (
  branch: string,
  options: Options,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const common = (yield* run(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    options,
  )).trim();

  const linked = path.join(common, "worktrees");

  const gitDirs = [
    common,
    ...((yield* fs.exists(linked))
      ? (yield* fs.readDirectory(linked)).map((name) => path.join(linked, name))
      : []),
  ];

  for (const gitDir of gitDirs)
    for (const kind of ["rebase-merge", "rebase-apply"]) {
      const file = path.join(gitDir, kind, "head-name");

      if (
        (yield* fs.exists(file)) &&
        (yield* fs.readFileString(file)).trim() === `refs/heads/${branch}`
      )
        return true;
    }

  return false;
});

/** The settings a branch's agent runs with. */
const agentSettings = Effect.gen(function* () {
  const settings = yield* Settings.load();
  const agent = settings.branches?.agent ?? settings.heal?.agents?.[0];

  if (agent === undefined)
    return yield* new AgentFailed({
      message:
        "This worker has no branches.agent or heal.agents in its settings",
    });

  return {
    agent,
    opencode: settings.heal?.opencode ?? "opencode2",
    minutes: settings.branches?.sessionMinutes ?? 30,
  };
});

/** The line an agent ends with when it stopped for a person. */
const needsYouLine = "Outcome: needs you";

const prompt = (entry: Managed, target: string, base: string, own: number) =>
  [
    `This worktree is \`${entry.branch}\`, which is kept on top of \`${entry.parent}\`. Rebase it onto \`${entry.parent}\` at ${target} (\`origin/${entry.parent}\` here), following this branch's AGENTS.md for how it's rebased, how to settle conflicts and what to check.`,
    "",
    `The branch's own commits are \`${base}..HEAD\` (${own}), so \`git rebase --onto ${target} ${base}\` replays just those, even where \`${entry.parent}\` was rewritten. It stands in for whatever AGENTS.md says to rebase onto.`,
    `\`${branchFile}\` is this branch's own: on a conflict in it keep this branch's side, and don't change it.`,
    "",
    "Run the checks AGENTS.md names once the rebase is done, and fix what the rebase broke in the commit it came from.",
    "Don't push: the worker pushes once you've finished.",
    `If AGENTS.md says to ask before something the rebase needs, or a conflict needs a decision only a person can make, stop where you are and end with the line \`${needsYouLine}\`.`,
    "End with a short summary of what conflicted and how you settled it, for someone reading it cold.",
  ].join("\n");

/** Run the agent in its session, for at most its minutes. */
const work = Effect.fnUntraced(function* (
  opencode: string,
  session: string,
  title: string,
  text: string,
  minutes: number,
  options: Options,
) {
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
 * Why the agent's result can't be pushed as it is, or null when it can: the
 * rebase has to be finished and clean, hold the parent's tip, have moved, and
 * leave the branch's own file as it was.
 */
const unfinished = Effect.fnUntraced(function* (
  start: string,
  target: string,
  options: Options,
) {
  const fs = yield* FileSystem.FileSystem;

  for (const kind of ["rebase-merge", "rebase-apply"]) {
    const gitPath = (yield* run(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-path", kind],
      options,
    )).trim();

    if (yield* fs.exists(gitPath)) return "the rebase is still in progress";
  }

  if ((yield* run("git", ["status", "--porcelain"], options)).trim() !== "")
    return "it left changes that aren't committed";

  const head = yield* revParse("HEAD", options);

  if (head === start) return "the branch didn't move";

  if (!(yield* contains(target, head, options)))
    return `the result doesn't have ${target.slice(0, 8)}, the parent's tip`;

  const before = yield* revParse(`${start}:${branchFile}`, options);

  const after = yield* revParse(`HEAD:${branchFile}`, options).pipe(
    Effect.orElseSucceed(() => ""),
  );

  if (before !== after) return `${branchFile} changed`;

  return null;
});

/**
 * Rebase one branch that's behind with an agent, then push what it did with
 * a lease on the tip it started from.
 */
const rebase = Effect.fnUntraced(function* (
  repo: string,
  entry: Managed,
  behind: number,
  place: Worktrees.Place,
) {
  const trusted = yield* Worktrees.root;
  const setup = yield* agentSettings;
  const directory = yield* Worktrees.checkout(repo, entry.branch, place);
  const options = { cwd: directory, trusted };

  // Until the agent starts, a failure leaves nothing for you, so the
  // worktree goes and the next run tries again
  const prepared = yield* Effect.gen(function* () {
    yield* fetch(entry.parent, options);

    if (yield* usesMise(directory))
      yield* run("mise", ["trust"], { cwd: directory, trusted: "" });

    const start = yield* revParse("HEAD", options);
    const target = yield* revParse(`origin/${entry.parent}`, options);

    // The fork point finds the branch's own commits after its parent was
    // rewritten, from the parent's reflog; without one, the merge base
    const base = yield* run(
      "git",
      ["merge-base", "--fork-point", `origin/${entry.parent}`, "HEAD"],
      options,
    ).pipe(
      Effect.catch(() =>
        run("git", ["merge-base", `origin/${entry.parent}`, "HEAD"], options),
      ),
      Effect.map((sha) => sha.trim()),
    );

    const own = Number(
      (yield* run(
        "git",
        ["rev-list", "--count", `${base}..HEAD`],
        options,
      )).trim(),
    );

    const session = yield* createSession(setup.opencode, setup.agent, options);

    return { start, target, base, own, session };
  }).pipe(Effect.tapCause(() => Worktrees.discard(directory)));

  const { start, target, base, own, session } = prepared;

  yield* RunLog.info(
    `${entry.branch}: ${behind} behind ${entry.parent}, rebasing in OpenCode session ${session} in ${directory}`,
  );

  // The lane is free for the next run once an agent is going
  yield* Lane.release;

  const stopped = yield* work(
    setup.opencode,
    session,
    `Rebase ${entry.branch} onto ${entry.parent}`,
    prompt(entry, target, base, own),
    setup.minutes,
    options,
  );

  const said = yield* lastWords(setup.opencode, session, options).pipe(
    Effect.orElseSucceed(() => null),
  );

  const left = (why: string) =>
    Effect.gen(function* () {
      yield* attention;

      return {
        kind: "needs-you",
        note: `${why}; its worktree ${directory} and session ${session} are kept for you`,
      } satisfies Outcome;
    });

  if (stopped !== null) return yield* left(stopped);

  if (said?.includes(needsYouLine) === true)
    return yield* left("the agent stopped for you");

  const why = yield* unfinished(start, target, options);

  if (why !== null) return yield* left(why);

  const pushedTo = yield* run(
    "git",
    [
      "push",
      "--quiet",
      `--force-with-lease=refs/heads/${entry.branch}:${start}`,
      "origin",
      `HEAD:refs/heads/${entry.branch}`,
    ],
    options,
  ).pipe(
    Effect.andThen(revParse("HEAD", options)),
    Effect.map(Option.some),
    Effect.catch((cause) =>
      RunLog.warn(`${entry.branch}: the push failed: ${String(cause)}`).pipe(
        Effect.as(Option.none<string>()),
      ),
    ),
  );

  if (Option.isNone(pushedTo)) {
    // A branch pushed while the agent worked keeps what was pushed, and the
    // next run rebases it again from there, so nothing is left for you
    const now = yield* fetch(entry.branch, options).pipe(
      Effect.andThen(revParse(`origin/${entry.branch}`, options)),
      Effect.orElseSucceed(() => start),
    );

    if (now === start)
      return yield* left("the push failed, and the branch hasn't moved");

    yield* Worktrees.discard(directory);

    return { kind: "moved" } satisfies Outcome;
  }

  yield* pushed(
    repo,
    pushedTo.value,
    `Rebase ${entry.branch} onto ${entry.parent}`,
    false,
  );
  yield* Worktrees.discard(directory);

  return { kind: "rebased", behind } satisfies Outcome;
});

/**
 * Keep one branch in step: count how far behind its parent it is, leaving
 * out the commits that only touch what it ignores, and rebase it when it's
 * behind and nothing else has it.
 */
const keep = Effect.fnUntraced(function* (
  repo: string,
  entry: Managed,
  worktrees: Worktrees.Run,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const key = `${repo.toLowerCase()}#${entry.branch}`;
  const name = repo.split("/").at(-1) ?? repo;

  const own = yield* Worktrees.forAgent(
    "branch",
    false,
    `${name}-${entry.branch}`,
  );

  const place = own.place(repo);

  if (working.has(key)) return { kind: "busy" } satisfies Outcome;

  const directory = yield* worktrees.checkout(repo, entry.branch, {
    submodules: false,
  });

  const options = { cwd: directory, trusted: worktrees.trusted };

  yield* fetch(entry.parent, options);

  const behind = Number(
    (yield* run(
      "git",
      [
        "rev-list",
        "--count",
        `origin/${entry.branch}..origin/${entry.parent}`,
        "--",
        ".",
        ...entry.ignore.map((ignored) => `:(exclude)${ignored}`),
      ],
      options,
    )).trim(),
  );

  const left = (yield* Worktrees.agents("branch")).find(
    (agent) => path.basename(agent.directory) === place.name,
  );

  if (behind === 0) {
    // In step again, so whatever an earlier agent left is done with
    if (left !== undefined && (yield* fs.exists(left.directory))) {
      yield* Worktrees.discard(left.directory);
      yield* RunLog.info(
        `${entry.branch}: in step again, so removed the worktree left in ${left.directory}`,
      );
    }

    return { kind: "in-step" } satisfies Outcome;
  }

  if (left !== undefined)
    return {
      kind: "needs-you",
      note: `${behind} behind, and still left for you in ${left.directory}`,
    } satisfies Outcome;

  if (yield* rebasing(entry.branch, options))
    return {
      kind: "needs-you",
      note: `${behind} behind, and a checkout here is part way through rebasing it`,
    } satisfies Outcome;

  working.add(key);

  return yield* rebase(repo, entry, behind, place).pipe(
    Effect.ensuring(Effect.sync(() => working.delete(key))),
  );
});

const describe = (outcome: Outcome) => {
  switch (outcome.kind) {
    case "in-step":
      return "in step";
    case "rebased":
      return `rebased, ${outcome.behind} behind before`;
    case "waiting":
      return `waiting for ${outcome.on}`;
    case "busy":
      return "an agent here is already rebasing it";
    case "moved":
      return "pushed to while the agent rebased it, so it's rebased again on the next run";
    case "needs-you":
      return outcome.note;
  }
};

/** Keep one repository's managed branches in step, parents first. */
const keepRepository = Effect.fnUntraced(function* (
  repo: string,
  worktrees: Worktrees.Run,
) {
  const branches = (yield* Api.pages(
    {
      endpoint: `repos/${repo}/branches`,
      method: "GET",
      query: { per_page: 100 },
    },
    Schema.Array(Branch),
  )).flatMap((page) => page.map((branch) => branch.name));

  const files = new Map<string, BranchFile>();
  const broken = new Map<string, string>();

  for (const branch of branches) {
    const text = yield* readBranchFile(repo, branch);

    if (Option.isNone(text)) continue;

    const file = yield* decode(text.value).pipe(Effect.result);

    if (Result.isFailure(file))
      broken.set(branch, `${branchFile} ${file.failure}`);
    else files.set(branch, file.success);
  }

  const { order, problems } = inOrder(files, new Set(branches));
  const held = new Map([...broken, ...problems]);

  if (held.size > 0) yield* attention;

  const outcomes = yield* walk(order, new Set(held.keys()), (entry) =>
    keep(repo, entry, worktrees).pipe(
      Effect.catchCause((cause) =>
        attention.pipe(
          Effect.as({
            kind: "needs-you",
            note: reason(cause),
          } satisfies Outcome),
        ),
      ),
    ),
  );

  const all: ReadonlyArray<readonly [string, Outcome]> = [
    ...[...held].map(
      ([branch, note]) =>
        [branch, { kind: "needs-you", note } satisfies Outcome] as const,
    ),
    ...outcomes,
  ];

  for (const [branch, outcome] of all) {
    const line = `${repo} ${branch}: ${describe(outcome)}`;

    yield* outcome.kind === "needs-you" ? RunLog.warn(line) : RunLog.info(line);
  }

  return all;
});

/** Keep the managed branches of each repository tracked for the job in step. */
export const branchDrift = Effect.fnUntraced(function* () {
  const worktrees = yield* Worktrees.forRun(Catalogue.branchDrift.id);
  const repos = yield* trackedRepos(Catalogue.branchDrift.id);
  const outcomes: Array<readonly [string, Outcome]> = [];

  for (const repo of repos)
    for (const [branch, outcome] of yield* keepRepository(repo, worktrees))
      outcomes.push([`${repo.split("/").at(-1) ?? repo} ${branch}`, outcome]);

  const of = (kind: Outcome["kind"]) =>
    outcomes.flatMap(([name, outcome]) =>
      outcome.kind === kind ? [name] : [],
    );

  const rebased = of("rebased");
  const yours = of("needs-you");

  yield* summary(
    [
      rebased.length === 0
        ? "Nothing rebased"
        : `Rebased ${rebased.join(", ")}`,
      `${of("in-step").length} in step`,
      ...(yours.length === 0 ? [] : [`${yours.join(", ")} need you`]),
      ...(of("waiting").length === 0
        ? []
        : [`${of("waiting").join(", ")} waiting on a parent`]),
      ...(of("busy").length === 0
        ? []
        : [`${of("busy").join(", ")} already being rebased`]),
      ...(of("moved").length === 0
        ? []
        : [
            `${of("moved").join(", ")} pushed to meanwhile, so tried again next run`,
          ]),
    ].join(", "),
  );

  if (rebased.length === 0 && yours.length === 0 && of("moved").length === 0)
    return skipped;
}, Effect.scoped);
