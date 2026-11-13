/**
 * Agents over checkouts. A heal's fix: check out the target in a worktree of
 * the agent's own, create an OpenCode session with the chosen model and
 * variant through OpenCode's API, checking both, and run it headless with
 * `opencode run` on the failed run, so nothing opens on the desktop. Several
 * repositories, a heal's consumers or a change you asked for, are checked
 * out side by side and worked on in the one session, each checked and pushed
 * on its own. The agent has the session limit, per repository up to four, to
 * finish; whatever it pushed is recorded as the run's commits and what it
 * said last as its summary.
 */
import { Api } from "@timmo001/effect-gh";
import { Domain } from "@upkeep/api";
import { Clock, Effect, Option, Path, Schema } from "effect";
import { reason } from "../Failure";
import * as CiTimings from "../CiTimings";
import * as Lane from "../Lane";
import * as Regression from "../Regression";
import { Reporter } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import * as Worktrees from "../Worktrees";
import { createSession, lastWords, recordCommits } from "./agent";
import { run, usesMise } from "./bump";

const RepositoryInfo = Schema.Struct({ default_branch: Schema.String });

/** A repository the agent works in, and where it's checked out. */
export interface Checkout {
  readonly repo: string;
  readonly directory: string;
  readonly branch: string;
}

/** What the session records as it goes: a heal's, or nothing. */
type Recorder = (update: {
  readonly session?: string;
  readonly directory?: string;
  readonly commit?: string;
}) => Effect.Effect<void, unknown>;

// How much of an earlier heal's summary the agent reads
const maxSaid = 2000;

/**
 * An earlier heal as the agent and the decision model read it: when it ran,
 * what was chosen, how it ended, what it pushed and what it said, cut to
 * `max` characters.
 */
export const earlierHeal = (heal: Domain.Run, max: number) => {
  const commits = heal.changes.map(
    (change) => `${change.repo}@${change.sha.slice(0, 7)}`,
  );

  return [
    new Date(heal.queuedAt).toISOString().slice(0, 10),
    heal.heal?.decision ?? "nothing chosen",
    heal.attention ? `${heal.state}, left for a person` : heal.state,
    ...(commits.length === 0 ? [] : [`pushed ${commits.join(", ")}`]),
  ]
    .join(", ")
    .concat(
      `: ${(heal.summary ?? heal.error ?? "(nothing said)").slice(0, max)}`,
    );
};

/** What the agent is told: the failure, how it went before, and how far it may go. */
const prompt = (
  heal: Domain.Heal,
  run: Domain.Run,
  log: ReadonlyArray<Domain.LogLine>,
  precedents: ReadonlyArray<Domain.Precedent>,
  earlier: ReadonlyArray<Domain.Run>,
  checkouts: ReadonlyArray<Checkout>,
  minutes: number,
  watching: string,
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
    ...(earlier.length === 0
      ? []
      : [
          "Earlier heals of this job for the same target, newest first, with what each found and did. Don't repeat what didn't work:",
          "",
          ...earlier.map(
            (before) =>
              `- ${earlierHeal(before, maxSaid).replaceAll("\n", "\n  ")}`,
          ),
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
    ...(log.some(({ message }) => message.includes(Regression.needsCheck))
      ? [
          `Some updates in the log ${Regression.needsCheck}: the line saying so gives why, with links to the release notes and changes. A held one wasn't pushed: apply it here as the job would, run the repository's checks, then check what the update could change, reading its notes for what to look at and using the app where you can. One whose regression commands failed is fixed like any other failure. Push it once it holds up. If it doesn't, or you can't tell, push nothing and say what you found, which is \`Outcome: needs you\`.`,
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
    watching,
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
 * Check out each repository side by side in worktrees of the agent's own, or
 * Upkeep's for none, and run one agent session over them all with the prompt
 * `ask` writes for them. Returns what happened, and records the session and
 * any commit as it goes. The worktrees go when the agent is done with them,
 * and are kept while it needs you; `prune` removes them once it doesn't.
 */
export const across = Effect.fnUntraced(function* (
  kind: string,
  repos: ReadonlyArray<string>,
  agent: Settings.Agent,
  title: string,
  ask: (
    checkouts: ReadonlyArray<Checkout>,
    minutes: number,
    watching: string,
  ) => string,
  record: Recorder,
) {
  const path = yield* Path.Path;
  const settings = (yield* Settings.load()).heal ?? {};
  const opencode = settings.opencode ?? "opencode2";
  const trusted = yield* Worktrees.root;

  const targets =
    repos.length === 0 ? [settings.repo ?? "timmo001/upkeep"] : repos;

  const several = targets.length > 1;
  const worktrees = yield* Worktrees.forAgent(kind, several);
  const made: Array<string> = [];

  const minutes =
    (settings.sessionMinutes ?? 30) * Math.min(Math.max(repos.length, 1), 4);

  const result = yield* Effect.gen(function* () {
    const checkouts = yield* Effect.forEach(
      targets,
      Effect.fnUntraced(function* (repo) {
        const { default_branch: branch } = yield* Api.json(
          { endpoint: `repos/${repo}`, method: "GET" },
          RepositoryInfo,
        );

        const directory = yield* Worktrees.checkout(
          repo,
          branch,
          worktrees.place(repo),
        );

        made.push(directory);

        // The agent's shell runs in OpenCode's service, which would ask before
        // trusting a new worktree's mise config. Trusting it needs the
        // worktrees left out of the trusted paths, or mise has nothing to do.
        if (yield* usesMise(directory))
          yield* run("mise", ["trust"], { cwd: directory, trusted: "" });

        const before = yield* tip(branch, { cwd: directory, trusted });

        return { repo, directory, branch, before };
      }),
    );

    // Several checkouts are worked on from the folder holding them all, or
    // their owner's in it when they share one
    const owners = new Set(checkouts.map(({ repo }) => repo.split("/")[0]));
    const folder = worktrees.folder ?? trusted;

    const directory = several
      ? owners.size === 1
        ? path.join(folder, [...owners][0] ?? "")
        : folder
      : (checkouts[0]?.directory ?? folder);

    const options = { cwd: directory, trusted };
    const session = yield* createSession(opencode, agent, options);

    yield* record({ session, directory });
    yield* RunLog.info(`Created OpenCode session ${session} in ${directory}`);

    const name = several
      ? `${checkouts.length} repositories`
      : (checkouts[0]?.repo.split("/").at(-1) ?? "");

    // The agent runs in the background: nothing opens on the desktop, and one
    // that needs a person is picked up from its session, in the heal's record.
    // A change frees its lane here; a heal's lane doesn't allow it, so the
    // heal sessions setting still caps how many agents run.
    yield* Lane.release;

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
        ask(
          checkouts,
          minutes,
          yield* CiTimings.advice(checkouts.map(({ repo }) => repo)),
        ),
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
      const after = yield* tip(branch, { cwd, trusted });

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
  }).pipe(
    Effect.onError(() =>
      Effect.forEach(made, (directory) => Worktrees.discard(directory), {
        discard: true,
      }),
    ),
  );

  if (!result.attention) yield* Worktrees.discard(result.directory);

  return result;
});

/** How long an agent's worktrees no heal still needs are kept, in case you look. */
const keptMillis = 7 * 24 * 60 * 60 * 1000;

/**
 * Remove the worktrees of heal and change agents that are done with them:
 * a heal's once it no longer needs you, and any other once it's a week old.
 * One still running, or left for you, is kept.
 */
export const prune = Effect.fnUntraced(
  function* () {
    const reporter = yield* Reporter;
    const now = yield* Clock.currentTimeMillis;

    const worked = (yield* reporter.heals(now - keptMillis)).flatMap((run) =>
      run.heal?.directory === null || run.heal?.directory === undefined
        ? []
        : [
            {
              directory: run.heal.directory,
              needed: run.finishedAt === null || run.attention,
            },
          ],
    );

    for (const kind of ["heal", "change"])
      for (const { directory, changed } of yield* Worktrees.agents(kind)) {
        const heals = worked.filter(
          (heal) =>
            heal.directory === directory ||
            heal.directory.startsWith(`${directory}/`),
        );

        if (heals.some((heal) => heal.needed)) continue;

        if (heals.length > 0 || now - changed > keptMillis)
          yield* Worktrees.discard(directory);
      }
  },
  Effect.catchCause((cause) =>
    RunLog.warn(`Couldn't remove agents' old worktrees: ${reason(cause)}`),
  ),
);

/**
 * The lines of a handed-off run's log a heal for one repository is about:
 * those naming that repository, so its agent isn't handed the others' work
 * or a log cut short by them. Any other heal, or one with no such lines, gets
 * the whole log.
 */
export const handedTo = (
  heal: Domain.Heal,
  run: Domain.Run,
  log: ReadonlyArray<Domain.LogLine>,
) => {
  if (run.state !== "handed-off" || heal.target.kind !== "consumer") return log;

  const prefix = `${heal.target.repo.toLowerCase()}:`;

  const own = log.filter((line) =>
    line.message.toLowerCase().startsWith(prefix),
  );

  return own.length === 0 ? log : own;
};

/** Hand a heal's fix to an agent, over the heal's target. */
export const fix = (
  heal: Domain.Heal,
  failed: Domain.Run,
  log: ReadonlyArray<Domain.LogLine>,
  precedents: ReadonlyArray<Domain.Precedent>,
  earlier: ReadonlyArray<Domain.Run>,
  agent: Settings.Agent,
  record: Recorder,
) =>
  across(
    "heal",
    Domain.targetRepos(heal.target),
    agent,
    failed.job,
    (checkouts, minutes, watching) =>
      prompt(
        heal,
        failed,
        handedTo(heal, failed, log),
        precedents,
        earlier,
        checkouts,
        minutes,
        watching,
      ),
    record,
  );
