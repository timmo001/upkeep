/**
 * Agents over checkouts. A heal's fix: check out the target, create an
 * OpenCode session with the chosen model and variant through OpenCode's API,
 * checking both, and run it headless with `opencode run` on the failed run,
 * so nothing opens on the desktop. Several repositories, a heal's consumers
 * or a change you asked for, are checked out side by side and worked on in
 * the one session, each checked and pushed on its own. The agent has the
 * session limit, per repository up to four, to finish; whatever it pushed is
 * recorded as the run's commits and what it said last as its summary.
 */
import { Api } from "@timmo001/effect-gh";
import { Domain } from "@upkeep/api";
import { Config, Effect, FileSystem, Option, Schema, Semaphore } from "effect";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { createSession, lastWords, recordCommits } from "./agent";
import { checkout, run, usesMise } from "./bump";

const RepositoryInfo = Schema.Struct({ default_branch: Schema.String });

const cacheRoot = Config.String("XDG_CACHE_HOME").pipe(
  Config.orElse(() =>
    Config.String("HOME").pipe(Config.map((home) => `${home}/.cache`)),
  ),
  Config.map((root) => `${root}/upkeep/heal`),
);

/** A repository the agent works in, and where it's checked out. */
export interface Checkout {
  readonly repo: string;
  readonly directory: string;
  readonly branch: string;
}

// Heals run side by side and share one checkout per repository, so a session
// holds its repositories' locks until it's done with them
const locks = new Map<string, Semaphore.Semaphore>();

const lockOf = (repo: string) => {
  const found = locks.get(repo);

  if (found !== undefined) return found;

  const lock = Semaphore.makeUnsafe(1);
  locks.set(repo, lock);

  return lock;
};

/** Run `effect` holding each repository's lock, taken in order so two never wait on each other. */
const holding = <A, E, R>(
  repos: ReadonlyArray<string>,
  effect: Effect.Effect<A, E, R>,
) =>
  [...new Set(repos.map((repo) => repo.toLowerCase()))]
    .sort()
    .reduceRight((inner, repo) => lockOf(repo).withPermit(inner), effect);

/** What the session records as it goes: a heal's, or nothing. */
type Recorder = (update: {
  readonly session?: string;
  readonly directory?: string;
  readonly commit?: string;
}) => Effect.Effect<void, unknown>;

/** What the agent is told: the failure, how it went before, and how far it may go. */
const prompt = (
  heal: Domain.Heal,
  run: Domain.Run,
  log: ReadonlyArray<Domain.LogLine>,
  precedents: ReadonlyArray<Domain.Precedent>,
  checkouts: ReadonlyArray<Checkout>,
  minutes: number,
) => {
  const several = checkouts.length > 1;
  const repo = several ? "each repository" : (checkouts[0]?.repo ?? "");

  const reach =
    heal.target.kind === "upkeep"
      ? [
          `You may run the job again, restart the Upkeep worker, push a fix to ${repo} once \`mise run check\` passes, and restart or update the Upkeep server, when the change is self-contained and Upkeep restarts cleanly.`,
          "On the Home Assistant box, use ha-bridge first, adding what's missing, before SSH.",
        ]
      : [
          `You may push a fix straight to ${repo}'s default branch once its own checks pass. Never open a pull request.`,
        ];

  const handedOff = run.state === "handed-off";

  return [
    handedOff
      ? `Upkeep's ${run.job} run ${run.id} handed work to you${heal.target.kind === "upkeep" ? "" : ` for ${Domain.targetName(heal.target)}`}, with nothing failing.`
      : `Upkeep's ${run.job} run ${run.id} failed${heal.target.kind === "upkeep" ? "" : ` for ${Domain.targetName(heal.target)}`}:`,
    "",
    ...(handedOff ? [] : [run.error ?? "(no error)", ""]),
    "The end of its log:",
    "",
    ...log.slice(-60).map((line) => `${line.level}: ${line.message}`),
    "",
    ...(precedents.length === 0
      ? []
      : [
          "The same or similar failures before, with triage's notes on them:",
          "",
          ...precedents.flatMap((precedent) => [
            `- ${precedent.title} (${precedent.state})`,
            ...precedent.notes.map(
              (note) => `  ${note.replaceAll("\n", "\n  ")}`,
            ),
          ]),
          "",
        ]),
    ...(several
      ? [
          handedOff
            ? "It handed off several repositories, checked out side by side here:"
            : "It failed the same way in several repositories, checked out side by side here:",
          "",
          ...checkouts.map(
            (checkout) =>
              `- ${checkout.repo} in ${checkout.directory} (${checkout.branch})`,
          ),
          "",
          handedOff
            ? "Do what the log asks of each. Run each repository's own checks in its own checkout and push each on its own, so one that can't be done doesn't hold up the rest."
            : "Find the cause once and make the same fix in each, adapting it where they differ. Run each repository's own checks in its own checkout and push each on its own, so one that can't be fixed doesn't hold up the rest.",
        ]
      : [
          handedOff
            ? `Do what the log asks of ${repo} in this checkout.`
            : `Find the cause and fix it in this checkout of ${repo}.`,
        ]),
    ...(run.job === "stalled-updates"
      ? [
          "The run was taking over the dependency update pull request named in the log. Apply its update here, migrate whatever the new version needs until the checks pass, push it, then close the pull request with a comment linking the commit. If it can't land because another dependency pins the old version exactly, even in its newest release, push nothing: close the pull request with a comment naming that pin, and that's `Outcome: fixed`.",
        ]
      : []),
    ...(run.job === "deps"
      ? [
          "The run was applying the dependency update groups named in the log, each as a commit to the default branch; the failed group's updates are in the log line for its `renovate/` branch. Apply that group here, read its release notes and migrate whatever the new versions need until the checks pass, push it, then close the updater's open pull request for that branch, if there is one, with a comment linking the commit. A drift failure after the updates is fixed as the drift job's would be.",
        ]
      : []),
    ...(run.job === "sync"
      ? [
          `The run was syncing the copies ${repo} takes from groundwork, listed in its sync.json. A copy changed in both is settled by moving the app's edit into groundwork, or into a wrapper in the app, then running groundwork's sync for this app (\`bun packages/sync/src/cli.ts run --app <this checkout>\` in groundwork) and pushing both. Anything else failed in the checks or CI after the push, and is fixed forward here.`,
        ]
      : []),
    ...(run.job === "drift-review"
      ? [
          `Nothing broke: you were asked to review ${repo} as a whole against the current release of each tool in its tooling.yml, as the log lists, for what it's still missing rather than only what changed since the last review. Read each tool's docs and release notes against what ${repo} covers, add what's missing, run its checks, and push to the default branch. What it already does must keep working as it does now: add to it, and change or remove existing behaviour only where the tool's release requires it. Leave anything large or uncertain for a person, saying what's missing. Finding nothing missing is \`Outcome: nothing to fix\`.`,
        ]
      : []),
    ...(run.job === "ci"
      ? [
          `${repo}'s CI is red on its default branch. The log has the failed run's failed steps and how its checks went here: tell a real failure from one only CI sees (a lockfile, the runner, a secret). Fix the cause, push, then watch CI on the commit until it passes.`,
        ]
      : []),
    ...reach,
    "Anything else, or anything you aren't sure of, is for a person: stop and say what you found and what you'd do.",
    `You have ${minutes} minutes. End with a short summary of what you found and did${several ? " in each repository" : ""}, for a person reading it cold, then a last line of exactly one of \`Outcome: fixed\`, \`Outcome: nothing to fix\` or \`Outcome: needs you\`${several ? ", which is `needs you` when any of them is left for a person" : ""}.`,
  ].join("\n");
};

/** The tip of a remote branch. */
const tip = (
  branch: string,
  options: { readonly cwd: string; readonly trusted: string },
) =>
  run("git", ["ls-remote", "origin", `refs/heads/${branch}`], options).pipe(
    Effect.map((output) => output.split("\t")[0]?.trim() ?? ""),
  );

/**
 * Check out each repository side by side, or Upkeep's own for none, and run
 * one agent session over them all with the prompt `ask` writes for them.
 * Returns what happened, and records the session and any commit as it goes.
 */
export const across = Effect.fnUntraced(
  function* (
    repos: ReadonlyArray<string>,
    agent: Settings.Agent,
    title: string,
    ask: (checkouts: ReadonlyArray<Checkout>, minutes: number) => string,
    record: Recorder,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const settings = (yield* Settings.load()).heal ?? {};
    const opencode = settings.opencode ?? "opencode2";
    const root = yield* cacheRoot;

    const several = repos.length > 1;

    const minutes =
      (settings.sessionMinutes ?? 30) * Math.min(Math.max(repos.length, 1), 4);

    yield* fs.makeDirectory(root, { recursive: true });

    const checkouts = yield* Effect.forEach(
      repos.length === 0 ? [settings.repo ?? "timmo001/upkeep"] : repos,
      Effect.fnUntraced(function* (repo) {
        const { default_branch: branch } = yield* Api.json(
          { endpoint: `repos/${repo}`, method: "GET" },
          RepositoryInfo,
        );

        const directory = `${root}/${repo}`;

        yield* checkout(repo, branch, directory, root);

        // The agent's shell runs in OpenCode's service, which would ask before
        // trusting a new checkout's mise config. Trusting it needs the cache
        // root left out of the trusted paths, or mise has nothing to do.
        if (yield* usesMise(directory))
          yield* run("mise", ["trust"], { cwd: directory, trusted: "" });

        const before = yield* tip(branch, { cwd: directory, trusted: root });

        return { repo, directory, branch, before };
      }),
    );

    // Several checkouts are worked on from the folder holding them all: their
    // owner's, or the cache root's when the owners differ
    const owners = new Set(checkouts.map(({ repo }) => repo.split("/")[0]));

    const directory = several
      ? owners.size === 1
        ? `${root}/${[...owners][0] ?? ""}`
        : root
      : (checkouts[0]?.directory ?? root);

    const options = { cwd: directory, trusted: root };
    const session = yield* createSession(opencode, agent, options);

    yield* record({ session, directory });
    yield* RunLog.info(`Created OpenCode session ${session} in ${directory}`);

    const name = several
      ? `${checkouts.length} repositories`
      : (checkouts[0]?.repo.split("/").at(-1) ?? "");

    // The agent runs in the background: nothing opens on the desktop, and one
    // that needs a person is picked up from its session, in the heal's record.
    const outcome = yield* run(
      opencode,
      [
        "run",
        // Nobody is there to answer a permission prompt; denied ones stay denied.
        "--auto",
        "--session",
        session,
        "--title",
        `${title} ${name}`,
        ask(checkouts, minutes),
      ],
      options,
    ).pipe(
      Effect.as("done" as const),
      Effect.catch((error) =>
        RunLog.warn(
          `The agent stopped: ${error instanceof Error ? error.message : String(error)}`,
        ).pipe(Effect.as("blocked" as const)),
      ),
      Effect.timeoutOption(`${minutes} minutes`),
      Effect.map(Option.getOrElse(() => "timeout" as const)),
    );

    const pushed: Array<string> = [];

    for (const { repo, directory: cwd, branch, before } of checkouts) {
      const after = yield* tip(branch, { cwd, trusted: root });

      if (after === "" || after === before) continue;

      // The heal's one commit only says something for one repository; several
      // are in its changes
      if (!several) yield* record({ commit: after });

      yield* recordCommits(repo, before, after);
      pushed.push(several ? `${repo}@${after.slice(0, 7)}` : after.slice(0, 7));
    }

    const note = pushed.length === 0 ? "" : `, and pushed ${pushed.join(", ")}`;

    const said = yield* lastWords(opencode, session, options).pipe(
      Effect.orElseSucceed(() => null),
    );

    const verdict =
      /Outcome:\s*(fixed|done|nothing to fix|nothing to do|needs you)\s*$/i
        .exec(said ?? "")?.[1]
        ?.toLowerCase();

    // A finished agent that pushed, or found nothing to do, is done with; one
    // that stopped, ran out of time or asked for a person isn't.
    const attention =
      outcome !== "done" ||
      verdict === "needs you" ||
      (verdict === undefined && pushed.length === 0);

    switch (outcome) {
      case "done":
        return {
          action: `The agent finished${note}`,
          session,
          directory,
          attention,
          said,
        };
      case "blocked":
        return {
          action: `The agent needs a person${note}`,
          session,
          directory,
          attention,
          said,
        };
      case "timeout":
        return {
          action: `The agent ran out of its ${minutes} minutes${note}; its session is left open`,
          session,
          directory,
          attention,
          said,
        };
    }
  },
  (effect, repos) =>
    Settings.load().pipe(
      Effect.map((settings) => settings.heal?.repo ?? "timmo001/upkeep"),
      Effect.flatMap((own) =>
        holding(repos.length === 0 ? [own] : repos, effect),
      ),
    ),
);

/** Hand a heal's fix to an agent, over the heal's target. */
export const fix = (
  heal: Domain.Heal,
  failed: Domain.Run,
  log: ReadonlyArray<Domain.LogLine>,
  precedents: ReadonlyArray<Domain.Precedent>,
  agent: Settings.Agent,
  record: Recorder,
) =>
  across(
    Domain.targetRepos(heal.target),
    agent,
    failed.job,
    (checkouts, minutes) =>
      prompt(heal, failed, log, precedents, checkouts, minutes),
    record,
  );
