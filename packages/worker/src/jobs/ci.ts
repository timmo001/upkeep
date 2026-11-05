/**
 * The ci job: read the latest run of each workflow on every tracked
 * repository's default branch. Where one failed, the repository's checks are
 * run in a clean clone, and both the failed run's log and the local result
 * are logged, so its heal can tell a real failure from one only CI sees. Once
 * a workflow passes again, its unread failure notifications are dismissed.
 * The run fails at the end, naming the repositories still red.
 */
import { Api, Workflow } from "@timmo001/effect-gh";
import { Catalogue } from "@upkeep/api";
import { Cause, Effect, Path, Schema } from "effect";
import { attention, listed, Reporter, summary } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { ConsumersFailed } from "../Worker";
import {
  cacheRoot,
  check,
  checkout,
  install,
  reason,
  run,
  usesMise,
} from "./bump";

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
  root: string,
  settings: Settings.Settings,
) {
  const path = yield* Path.Path;
  const directory = path.join(root, repo);
  const options = { cwd: directory, trusted: root };

  yield* checkout(repo, branch, directory, root);

  const mise = yield* usesMise(directory);

  yield* install(directory, ["package.json"], { trusted: root, mise });

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

    yield* Api.empty({
      endpoint: `notifications/threads/${thread.id}`,
      method: "DELETE",
    });
    yield* RunLog.info(
      `${repo}: dismissed "${thread.subject.title}", it passes again`,
    );
  }
});

/** Read one repository's default branch, checking it here when it's red. */
const ciRepository = Effect.fnUntraced(function* (
  repo: string,
  context: {
    readonly root: string;
    readonly settings: Settings.Settings;
    readonly threads: ReadonlyArray<Thread>;
  },
) {
  const info = yield* Api.json(
    { endpoint: `repos/${repo}`, method: "GET" },
    RepositoryInfo,
  );

  if (info.archived) return "green" as const;

  const branch = info.default_branch;

  const { workflows } = yield* Api.json(
    {
      endpoint: `repos/${repo}/actions/workflows`,
      method: "GET",
      query: { per_page: 100 },
    },
    Workflows,
  );

  const { failed, passing } = latest(
    yield* Workflow.list({ repo, branch, limit: 50 }),
    new Set(
      workflows
        .filter((workflow) => workflow.state === "active")
        .map((workflow) => workflow.name),
    ),
  );

  yield* dismiss(repo, branch, passing, context.threads);

  if (failed.length === 0) return "green" as const;

  for (const item of failed) {
    yield* RunLog.warn(
      `${repo}: ${item.workflowName ?? item.name} ${item.conclusion ?? "failed"} on ${branch} at ${item.headSha.slice(0, 7)} ${item.url}\n${yield* failedLog(repo, item)}`,
    );
  }

  yield* checkHere(repo, branch, context.root, context.settings);

  return "red" as const;
});

/** Read every tracked repository's CI, four at a time. */
export const ci = Effect.fnUntraced(function* () {
  const settings = yield* Settings.load();
  const path = yield* Path.Path;
  const root = path.join(path.dirname(yield* cacheRoot), "ci");
  const reporter = yield* Reporter;
  const repos = yield* reporter.repos(Catalogue.ci.id);

  const pages = yield* Api.pages(
    { endpoint: "notifications", method: "GET", query: { per_page: 100 } },
    Schema.Array(Thread),
  );

  const threads = pages
    .flat()
    .filter((thread) => thread.unread && thread.subject.type === "CheckSuite");

  yield* RunLog.info(`Reading CI on ${repos.length} repositories`);

  const failed: Array<string> = [];

  yield* Effect.forEach(
    repos,
    (repo) =>
      ciRepository(repo, { root, settings, threads }).pipe(
        Effect.catchCause((cause) =>
          RunLog.warn(
            `${repo}: couldn't read its CI: ${Cause.pretty(cause)}`,
          ).pipe(Effect.as("red" as const)),
        ),
        Effect.tap((state) =>
          Effect.sync(() => {
            if (state === "red") failed.push(repo);
          }),
        ),
      ),
    { concurrency: 4, discard: true },
  );

  yield* summary(
    failed.length === 0
      ? `All ${repos.length} repositories are green`
      : `${repos.length - failed.length} of ${repos.length} repositories are green; red: ${listed(failed.toSorted())}`,
  );

  if (failed.length > 0) yield* attention;

  if (failed.length > 0)
    return yield* new ConsumersFailed({
      action: "get CI green on",
      repos: failed.toSorted(),
    });
});
