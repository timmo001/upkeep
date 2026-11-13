/**
 * The ci job: read the latest run of each workflow on every tracked
 * repository's default branch. Where one failed, the repository's checks are
 * run in a clean worktree, and both the failed run's log and the local result
 * are logged, so its heal can tell a real failure from one only CI sees. Once
 * a workflow passes again, its unread failure notifications are dismissed.
 * The run fails at the end, naming the repositories still red. One whose CI
 * couldn't be read, even after retries, is named but not counted red, as is
 * one whose failed runs all ran out of GitHub's rate limit: those are run
 * again once, with no heal, and left for you only when they run out again.
 * The runs read add to {@link CiTimings}.
 * Repository details and workflow lists are kept between runs and asked for
 * conditionally, so unchanged ones cost no rate limit. It runs as the GitHub
 * App, apart from your notifications, which only your login can read.
 */
import { Api, Workflow } from "@timmo001/effect-gh";
import { Catalogue } from "@upkeep/api";
import { Effect, Option, Schedule, Schema } from "effect";
import * as CiTimings from "../CiTimings";
import { pretty, reason } from "../Failure";
import * as GitHubApp from "../GitHubApp";
import * as Kept from "../Kept";
import * as RateLimits from "../RateLimits";
import { attention, listed, Reporter, summary } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { ConsumersFailed } from "../Worker";
import * as Worktrees from "../Worktrees";
import { check, install, run, usesMise } from "./bump";

const RepositoryInfo = Schema.Struct({
  archived: Schema.Boolean,
  default_branch: Schema.String,
});

const Workflows = Schema.Struct({
  workflows: Schema.Array(
    Schema.Struct({ name: Schema.String, state: Schema.String }),
  ),
});

const Thread = Schema.Struct({
  id: Schema.String,
  unread: Schema.Boolean,
  subject: Schema.Struct({ title: Schema.String, type: Schema.String }),
  repository: Schema.Struct({ full_name: Schema.String }),
});

type Thread = typeof Thread.Type;

const passed = new Set(["success", "skipped", "neutral"]);

/**
 * How the branch stands: the latest finished run of each workflow that's
 * still active, so one since removed or turned off doesn't count.
 */
export const latest = (
  runs: ReadonlyArray<Workflow.Run>,
  active: ReadonlySet<string>,
) => {
  const seen = new Set<string>();
  const failed: Array<Workflow.Run> = [];
  const passing = new Set<string>();

  // Runs come newest first; a cancelled run was usually replaced, so it says
  // nothing about the branch either way. Dynamic runs are GitHub's own jobs,
  // such as Dependabot Updates, rather than the repository's CI.
  for (const item of runs) {
    const workflow = item.workflowName ?? item.name;

    if (
      item.event.startsWith("pull_request") ||
      item.event === "dynamic" ||
      item.status !== "completed" ||
      item.conclusion === "cancelled" ||
      !active.has(workflow) ||
      seen.has(workflow)
    )
      continue;

    seen.add(workflow);

    if (passed.has(item.conclusion ?? "")) passing.add(workflow);
    else failed.push(item);
  }

  return { failed, passing };
};

/** The workflow and branch a CI failure notification is about. */
export const failureOf = (title: string) => {
  const match = /^(.+) workflow run (?:failed|cancelled) for (.+) branch$/.exec(
    title,
  );

  return match === null
    ? undefined
    : { workflow: match[1] ?? "", branch: match[2] ?? "" };
};

/**
 * The steps that only tidy up after a job, such as `Post Run
 * actions/checkout`, whose lines would push out the failure itself.
 */
const tidyStep = /^(Post |Complete job$|Set up job$)/;

/** A failed step that ran out of GitHub's rate limit, primary or secondary. */
const rateLimited = /API rate limit exceeded|secondary rate limit/i;

/** The end of a failed run's failed steps, for the heal. */
const failedLog = (repo: string, item: Workflow.Run) =>
  Workflow.logs({ repo, runId: item.databaseId, failedOnly: true }).pipe(
    Effect.map((log) =>
      log
        .trim()
        .split("\n")
        .filter((line) => !tidyStep.test(line.split("\t")[1] ?? ""))
        .slice(-30)
        .map((line) => line.split("\t").slice(2).join("\t") || line)
        .join("\n"),
    ),
    Effect.catchCause((cause) =>
      Effect.succeed(`(couldn't read its log: ${reason(cause)})`),
    ),
  );

/**
 * Run the repository's checks on a clean clone of the branch, saying whether
 * installing changed a lockfile, which CI's frozen install would refuse.
 */
const checkHere = Effect.fnUntraced(function* (
  repo: string,
  branch: string,
  worktrees: Worktrees.Run,
  settings: Settings.Settings,
) {
  const { trusted } = worktrees;
  const directory = yield* worktrees.checkout(repo, branch);
  const options = { cwd: directory, trusted };

  const mise = yield* usesMise(directory);

  yield* install(directory, ["package.json"], { trusted, mise });

  const changed = (yield* run("git", ["status", "--porcelain"], options))
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(3));

  if (changed.length > 0)
    yield* RunLog.warn(
      `${repo}: installing here changed ${changed.join(", ")}, so a frozen install in CI fails`,
    );

  const ran = yield* check(settings.bump?.repos?.[repo]?.checks, {
    ...options,
    mise,
  }).pipe(
    Effect.catchCause((cause) =>
      RunLog.warn(`${repo}: the checks fail here too: ${reason(cause)}`).pipe(
        Effect.as(undefined),
      ),
    ),
  );

  if (ran === undefined) return;

  yield* RunLog.warn(
    ran.length === 0
      ? `${repo}: there's no check or build task to run here`
      : `${repo}: ${ran.join(", ")} passed here, so it fails only in CI`,
  );
});

/** Dismiss a repository's unread failure notifications for workflows that pass again. */
const dismiss = Effect.fnUntraced(function* (
  repo: string,
  branch: string,
  passing: ReadonlySet<string>,
  threads: ReadonlyArray<Thread>,
) {
  for (const thread of threads) {
    const failure = failureOf(thread.subject.title);

    if (
      thread.repository.full_name.toLowerCase() !== repo.toLowerCase() ||
      failure === undefined ||
      failure.branch !== branch ||
      !passing.has(failure.workflow)
    )
      continue;

    yield* GitHubApp.withMachineLogin(
      Api.empty({
        endpoint: `notifications/threads/${thread.id}`,
        method: "DELETE",
      }),
    );
    yield* RunLog.info(
      `${repo}: dismissed "${thread.subject.title}", it passes again`,
    );
  }
});

/** How a repository's default branch stands, or `undefined` when it's archived. */
const readBranch = Effect.fnUntraced(function* (repo: string, kept: Kept.Kept) {
  const info = yield* kept
    .get({ endpoint: `repos/${repo}` })
    .pipe(
      Effect.flatMap(({ value }) =>
        Schema.decodeUnknownEffect(RepositoryInfo)(value),
      ),
    );

  if (info.archived) return undefined;

  const branch = info.default_branch;

  const { workflows } = yield* kept
    .get({
      endpoint: `repos/${repo}/actions/workflows`,
      query: { per_page: 100 },
    })
    .pipe(
      Effect.flatMap(({ value }) =>
        Schema.decodeUnknownEffect(Workflows)(value),
      ),
    );

  const runs = yield* Api.json(
    {
      endpoint: `repos/${repo}/actions/runs`,
      method: "GET",
      query: { branch, per_page: 50 },
    },
    CiTimings.ApiRuns,
  );

  yield* CiTimings.record(repo, runs.workflow_runs);

  return {
    branch,
    ...latest(
      runs.workflow_runs.map(CiTimings.toRun),
      new Set(
        workflows
          .filter((workflow) => workflow.state === "active")
          .map((workflow) => workflow.name),
      ),
    ),
  };
});

/**
 * Run the failed jobs of runs that ran out of GitHub's rate limit again, once
 * each. The limit they ran out of is usually your login's, which workflows
 * that publish with a personal token use, so while that's still down to its
 * reserve they're left for a later ci run. A run that already ran again and
 * failed the same way is left for you.
 */
const runAgain = Effect.fnUntraced(function* (
  repo: string,
  failed: ReadonlyArray<Workflow.Run>,
) {
  const low = yield* GitHubApp.withMachineLogin(RateLimits.low());

  if (Option.isSome(low)) {
    yield* RunLog.warn(
      `${repo}: it failed on GitHub's rate limit, which is still low until ${RateLimits.at(low.value.reset)}, so a later ci run runs it again`,
    );

    return "rerun" as const;
  }

  let again = true;

  for (const item of failed) {
    const workflow = item.workflowName ?? item.name;

    if (item.attempt > 1) {
      yield* RunLog.warn(
        `${repo}: ${workflow} failed on GitHub's rate limit again after running again, so it's left for you`,
      );
      again = false;

      continue;
    }

    const ran = yield* Workflow.rerun({
      repo,
      runId: item.databaseId,
      failedOnly: true,
    }).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        RunLog.warn(
          `${repo}: couldn't run ${workflow} again: ${reason(cause)}`,
        ).pipe(Effect.as(false)),
      ),
    );

    if (ran)
      yield* RunLog.info(
        `${repo}: ${workflow} failed on GitHub's rate limit, so its failed jobs are running again ${item.url}`,
      );

    again &&= ran;
  }

  return again ? ("rerun" as const) : ("limited" as const);
});

/**
 * Read one repository's default branch, checking it here when it's red. A
 * read that keeps failing says nothing about its CI, so the repository is
 * left out rather than counted red, which would queue a heal for it.
 */
const ciRepository = Effect.fnUntraced(function* (
  repo: string,
  context: {
    readonly worktrees: Worktrees.Run;
    readonly settings: Settings.Settings;
    readonly threads: ReadonlyArray<Thread>;
    readonly kept: Kept.Kept;
  },
) {
  const read = yield* readBranch(repo, context.kept).pipe(
    Effect.retry({ schedule: Schedule.exponential("5 seconds"), times: 2 }),
    Effect.map((state) => ({ ok: true as const, state })),
    Effect.catchCause((cause) =>
      RunLog.warn(
        `${repo}: couldn't read its CI, so it's left out: ${pretty(cause)}`,
      ).pipe(Effect.as({ ok: false as const })),
    ),
  );

  if (!read.ok) return "unread" as const;

  if (read.state === undefined) return "green" as const;

  const { branch, failed, passing } = read.state;

  yield* dismiss(repo, branch, passing, context.threads);

  if (failed.length === 0) return "green" as const;

  const logs = yield* Effect.forEach(failed, (item) =>
    failedLog(repo, item).pipe(Effect.map((log) => ({ item, log }))),
  );

  for (const { item, log } of logs) {
    yield* RunLog.warn(
      `${repo}: ${item.workflowName ?? item.name} ${item.conclusion ?? "failed"} on ${branch} at ${item.headSha.slice(0, 7)} ${item.url}\n${log}`,
    );
  }

  // A run that failed on a spent rate limit needs running again, not fixing
  if (logs.every(({ log }) => rateLimited.test(log)))
    return yield* runAgain(repo, failed);

  yield* checkHere(repo, branch, context.worktrees, context.settings);

  return "red" as const;
});

/** Read every tracked repository's CI, four at a time. */
export const ci = Effect.fnUntraced(function* () {
  const settings = yield* Settings.load();
  const worktrees = yield* Worktrees.forRun("ci");
  const reporter = yield* Reporter;
  const repos = yield* reporter.repos(Catalogue.ci.id);
  const kept = yield* Kept.make("ci");

  const pages = yield* GitHubApp.withMachineLogin(
    Api.pages(
      { endpoint: "notifications", method: "GET", query: { per_page: 100 } },
      Schema.Array(Thread),
    ),
  );

  const threads = pages
    .flat()
    .filter((thread) => thread.unread && thread.subject.type === "CheckSuite");

  yield* RunLog.info(`Reading CI on ${repos.length} repositories`);

  const failed: Array<string> = [];
  const rerun: Array<string> = [];
  const limited: Array<string> = [];
  const unread: Array<string> = [];

  yield* Effect.forEach(
    repos,
    (repo) =>
      ciRepository(repo, { worktrees, settings, threads, kept }).pipe(
        Effect.catchCause((cause) =>
          RunLog.warn(`${repo}: couldn't check its CI: ${pretty(cause)}`).pipe(
            Effect.as("red" as const),
          ),
        ),
        Effect.tap((state) =>
          Effect.sync(() => {
            if (state === "red") failed.push(repo);

            if (state === "rerun") rerun.push(repo);

            if (state === "limited") limited.push(repo);

            if (state === "unread") unread.push(repo);
          }),
        ),
      ),
    { concurrency: 4, discard: true },
  );

  const read = repos.length - unread.length;
  const green = read - failed.length - rerun.length - limited.length;

  const left = [
    ...(rerun.length === 0
      ? []
      : [
          `running again after GitHub's rate limit ran out: ${listed(rerun.toSorted())}`,
        ]),
    ...(limited.length === 0
      ? []
      : [
          `ran out of GitHub's rate limit again after running again: ${listed(limited.toSorted())}`,
        ]),
    ...(unread.length === 0
      ? []
      : [`couldn't read ${listed(unread.toSorted())}`]),
  ]
    .map((part) => `; ${part}`)
    .join("");

  yield* summary(
    green === read
      ? `All ${read} repositories are green${left}`
      : failed.length === 0
        ? `${green} of ${read} repositories are green${left}`
        : `${green} of ${read} repositories are green; red: ${listed(failed.toSorted())}${left}`,
  );

  if (failed.length > 0 || limited.length > 0) yield* attention;

  if (failed.length > 0)
    return yield* new ConsumersFailed({
      action: "get CI green on",
      repos: failed.toSorted(),
    });
}, Effect.scoped);
