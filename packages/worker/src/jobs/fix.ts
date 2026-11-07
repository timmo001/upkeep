/**
 * A heal's fix: check out the target, create an OpenCode session with the
 * chosen model and variant through OpenCode's API, checking both, and run it
 * headless with `opencode run` on the failed run, so nothing opens on the
 * desktop. The agent has the session limit to finish; whatever it pushed is
 * recorded as the heal's commits and what it said last as its summary.
 */
import { Api } from "@timmo001/effect-gh";
import type { Domain } from "@upkeep/api";
import { Config, Effect, FileSystem, Option, Schema } from "effect";
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

/** What the agent is told: the failure, how it went before, and how far it may go. */
const prompt = (
  heal: Domain.Heal,
  run: Domain.Run,
  log: ReadonlyArray<Domain.LogLine>,
  precedents: ReadonlyArray<Domain.Precedent>,
  repo: string,
  minutes: number,
) => {
  const reach =
    heal.target.kind === "upkeep"
      ? [
          `You may run the job again, restart the Upkeep worker, push a fix to ${repo} once \`mise run check\` passes, and restart or update the Upkeep server, when the change is self-contained and Upkeep restarts cleanly.`,
          "On the Home Assistant box, use ha-bridge first, adding what's missing, before SSH.",
        ]
      : [
          `You may push a fix straight to ${repo}'s default branch once its own checks pass. Never open a pull request.`,
        ];

  return [
    `Upkeep's ${run.job} run ${run.id} failed${heal.target.kind === "consumer" ? ` for ${repo}` : ""}:`,
    "",
    run.error ?? "(no error)",
    "",
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
    `Find the cause and fix it in this checkout of ${repo}.`,
    ...(run.job === "stalled-updates"
      ? [
          "The run was taking over the dependency update pull request named in the log. Apply its update here, migrate whatever the new version needs until the checks pass, push it, then close the pull request with a comment linking the commit.",
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
          `Nothing broke: you were asked to review ${repo} as a whole against the current release of each tool in its tooling.yml, as the log lists, for what it's still missing rather than only what changed since the last review. Read each tool's docs and release notes against what ${repo} covers, add what's missing, run its checks, and push to the default branch. Leave anything large or uncertain for a person, saying what's missing. Finding nothing missing is \`Outcome: nothing to fix\`.`,
        ]
      : []),
    ...(run.job === "ci"
      ? [
          `${repo}'s CI is red on its default branch. The log has the failed run's failed steps and how its checks went here: tell a real failure from one only CI sees (a lockfile, the runner, a secret). Fix the cause, push, then watch CI on the commit until it passes.`,
        ]
      : []),
    ...reach,
    "Anything else, or anything you aren't sure of, is for a person: stop and say what you found and what you'd do.",
    `You have ${minutes} minutes. End with a short summary of what you found and did, for a person reading it cold, then a last line of exactly one of \`Outcome: fixed\`, \`Outcome: nothing to fix\` or \`Outcome: needs you\`.`,
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
 * Hand a fix to an agent. Returns what happened, for the heal's record, and
 * records the session and any commit as it goes.
 */
export const fix = Effect.fnUntraced(function* (
  heal: Domain.Heal,
  failed: Domain.Run,
  log: ReadonlyArray<Domain.LogLine>,
  precedents: ReadonlyArray<Domain.Precedent>,
  agent: Settings.Agent,
  record: (update: {
    readonly session?: string;
    readonly directory?: string;
    readonly commit?: string;
  }) => Effect.Effect<void, unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  const settings = (yield* Settings.load()).heal ?? {};
  const opencode = settings.opencode ?? "opencode2";
  const minutes = settings.sessionMinutes ?? 30;
  const root = yield* cacheRoot;

  const repo =
    heal.target.kind === "consumer"
      ? heal.target.repo
      : (settings.repo ?? "timmo001/upkeep");

  const { default_branch: branch } = yield* Api.json(
    { endpoint: `repos/${repo}`, method: "GET" },
    RepositoryInfo,
  );

  const directory = `${root}/${repo}`;
  const options = { cwd: directory, trusted: root };

  yield* fs.makeDirectory(root, { recursive: true });
  yield* checkout(repo, branch, directory, root);

  // The agent's shell runs in OpenCode's service, which would ask before
  // trusting a new checkout's mise config. Trusting it needs the cache root
  // left out of the trusted paths, or mise has nothing to do.
  if (yield* usesMise(directory))
    yield* run("mise", ["trust"], { cwd: directory, trusted: "" });

  const before = yield* tip(branch, options);
  const session = yield* createSession(opencode, agent, options);

  yield* record({ session, directory });
  yield* RunLog.info(`Created OpenCode session ${session} in ${directory}`);

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
      `${failed.job} ${repo.split("/").at(-1) ?? repo}`,
      prompt(heal, failed, log, precedents, repo, minutes),
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

  const after = yield* tip(branch, options);

  if (after !== "" && after !== before) {
    yield* record({ commit: after });
    yield* recordCommits(repo, before, after);
  }

  const note = after !== before ? `, and pushed ${after.slice(0, 7)}` : "";

  const said = yield* lastWords(opencode, session, options).pipe(
    Effect.orElseSucceed(() => null),
  );

  const verdict = /Outcome:\s*(fixed|nothing to fix|needs you)\s*$/i
    .exec(said ?? "")?.[1]
    ?.toLowerCase();

  // A finished agent that pushed a fix, or found nothing to fix, is done
  // with; one that stopped, ran out of time or asked for a person isn't.
  const attention =
    outcome !== "done" ||
    verdict === "needs you" ||
    (verdict === undefined && after === before);

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
});
