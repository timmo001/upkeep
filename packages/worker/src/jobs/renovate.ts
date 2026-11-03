/**
 * The renovate job: take over Renovate pull requests that stalled because
 * their checks failed. Each one is squashed onto a clean checkout of the
 * default branch, checked, pushed straight to it and closed with a link to
 * the commit, then CI is watched. A repository that fails is logged and the
 * rest carry on; the run fails at the end, naming them, so a heal can fix
 * each one forward.
 */
import { Api, Workflow } from "@timmo001/effect-gh";
import { Config, Effect, Path, Schema } from "effect";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { ConsumersFailed } from "../Worker";
import {
  cacheRoot,
  check,
  checkout,
  commitAndPush,
  install,
  reason,
  run,
  usesMise,
  watch,
} from "./bump";

const User = Schema.Struct({ login: Schema.String });

const Found = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ number: Schema.Int, repository_url: Schema.String }),
  ),
});

const PullRequest = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  html_url: Schema.String,
  draft: Schema.Boolean,
  head: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
  base: Schema.Struct({
    ref: Schema.String,
    repo: Schema.Struct({
      full_name: Schema.String,
      default_branch: Schema.String,
      archived: Schema.Boolean,
      fork: Schema.Boolean,
    }),
  }),
});

export type PullRequest = typeof PullRequest.Type;

const passed = new Set(["success", "skipped", "neutral"]);

/** How a pull request's CI on its head commit went. */
export type Checks = "failed" | "passed" | "pending" | "none";

export const checksOf = (
  runs: ReadonlyArray<{
    readonly status: string;
    readonly conclusion: string | null;
  }>,
): Checks => {
  if (runs.length === 0) return "none";

  if (runs.some((item) => item.status !== "completed")) return "pending";

  return runs.every((item) => passed.has(item.conclusion ?? ""))
    ? "passed"
    : "failed";
};

/**
 * Why a pull request is left to Renovate, or `undefined` when Upkeep should
 * take it over: an open update from Renovate's own branch into the default
 * branch, whose checks have all finished and some failed.
 */
export const leftBecause = (pr: PullRequest, checks: Checks) => {
  if (pr.head.ref === "renovate/configure") return "Renovate's onboarding";

  if (!pr.head.ref.startsWith("renovate/")) return "not a Renovate branch";

  if (pr.title.endsWith(" - abandoned")) return "abandoned by Renovate";

  if (pr.head.repo?.full_name !== pr.base.repo.full_name) return "from a fork";

  if (pr.base.ref !== pr.base.repo.default_branch)
    return `into ${pr.base.ref}, not the default branch`;

  if (pr.base.repo.archived) return "archived";

  if (pr.base.repo.fork) return "a fork";

  if (pr.draft) return "a draft";

  switch (checks) {
    case "failed":
      return undefined;
    case "passed":
      return "its checks pass";
    case "pending":
      return "its checks are still running";
    case "none":
      return "no checks ran";
  }
};

/** Every open Renovate pull request in the signed-in account's repositories. */
const open = Effect.fnUntraced(function* () {
  const { login } = yield* Api.json({ endpoint: "user", method: "GET" }, User);

  const { items } = yield* Api.json(
    {
      endpoint: "search/issues",
      method: "GET",
      query: {
        q: `is:pr is:open archived:false author:app/renovate user:${login}`,
        per_page: 100,
      },
    },
    Found,
  );

  const prefix = "https://api.github.com/repos/";

  return items.map((item) => ({
    repo: item.repository_url.slice(prefix.length),
    number: item.number,
  }));
});

interface TakeoverContext {
  readonly root: string;
  readonly settings: Settings.Settings;
  readonly dryRun: boolean;
}

/** Close a pull request, saying where its update landed. */
const close = Effect.fnUntraced(function* (pr: PullRequest, text: string) {
  const repo = pr.base.repo.full_name;

  yield* Api.empty({
    endpoint: `repos/${repo}/issues/${pr.number}/comments`,
    method: "POST",
    body: { body: text },
  });

  yield* Api.empty({
    endpoint: `repos/${repo}/pulls/${pr.number}`,
    method: "PATCH",
    body: { state: "closed" },
  });
});

/** Squash one pull request onto the default branch, check, push and close it. */
const takeOver = Effect.fnUntraced(function* (
  pr: PullRequest,
  context: TakeoverContext,
) {
  const path = yield* Path.Path;
  const repo = pr.base.repo.full_name;
  const branch = pr.base.ref;
  const directory = path.join(context.root, repo);
  const options = { cwd: directory, trusted: context.root };

  yield* RunLog.info(
    `${repo}: taking over "${pr.title}" ${pr.html_url}, whose checks failed`,
  );

  yield* checkout(repo, branch, directory, context.root);
  yield* run("git", ["fetch", "--quiet", "origin", pr.head.sha], options);
  yield* run("git", ["merge", "--squash", "--quiet", pr.head.sha], options);

  const staged = yield* run(
    "git",
    ["diff", "--cached", "--name-only"],
    options,
  );

  if (staged.trim() === "") {
    yield* RunLog.info(`${repo}: already on ${branch}, closing it`);

    if (!context.dryRun)
      yield* close(
        pr,
        `Upkeep closed this: \`${branch}\` already has this update.`,
      );

    return;
  }

  const files = staged.trim().split("\n");
  const mise = yield* usesMise(directory);

  // Install against the updated lockfile, so the checks see the new versions
  yield* install(
    directory,
    ["package.json", ...files.filter((file) => file.endsWith("package.json"))],
    { trusted: context.root, mise },
  );
  yield* run("git", ["add", "--update"], options);

  const ran = yield* check(context.settings.bump?.repos?.[repo]?.checks, {
    ...options,
    mise,
  });

  yield* ran.length === 0
    ? RunLog.warn(
        `${repo}: has no check or build task, so nothing ran before the push`,
      )
    : RunLog.info(`${repo}: ${ran.join(", ")} passed`);

  const message = `${pr.title} (#${pr.number})`;

  if (context.dryRun) {
    yield* RunLog.info(
      `${repo}: would push "${message}" (${files.join(", ")})`,
    );

    return;
  }

  const sha = yield* commitAndPush(message, branch, options);

  yield* close(
    pr,
    `Upkeep took this update over after its checks failed here, and pushed it to \`${branch}\` in ${sha}.`,
  );

  yield* RunLog.info(
    `${repo}: pushed ${sha.slice(0, 7)} "${message}" and closed the pull request, watching CI`,
  );

  const runs = yield* watch(repo, sha);

  yield* RunLog.info(
    runs === 0
      ? `${repo}: no CI ran on ${sha.slice(0, 7)}`
      : `${repo}: CI passed`,
  );
});

/**
 * Take over every stalled Renovate pull request: one repository's in turn,
 * four repositories at a time.
 */
export const renovate = Effect.fnUntraced(function* () {
  const settings = yield* Settings.load();
  const path = yield* Path.Path;
  const root = path.join(path.dirname(yield* cacheRoot), "renovate");

  const dryRun = yield* Config.Boolean("UPKEEP_RENOVATE_DRY_RUN").pipe(
    Config.withDefault(false),
  );

  const found = yield* open();
  const byRepo = new Map<string, Array<PullRequest>>();
  let left = 0;

  for (const { repo, number } of found) {
    const pr = yield* Api.json(
      { endpoint: `repos/${repo}/pulls/${number}`, method: "GET" },
      PullRequest,
    );

    const checks = checksOf(
      yield* Workflow.list({ repo, commit: pr.head.sha, limit: 50 }),
    );

    const because = leftBecause(pr, checks);

    if (because !== undefined) {
      left += 1;
      yield* RunLog.info(`${repo}#${number}: left, ${because}`);

      continue;
    }

    byRepo.set(repo, [...(byRepo.get(repo) ?? []), pr]);
  }

  const taking = [...byRepo.values()].reduce(
    (total, prs) => total + prs.length,
    0,
  );

  yield* RunLog.info(
    `${found.length} open Renovate pull requests: ${dryRun ? "would take over" : "taking over"} ${taking}, leaving ${left}`,
  );

  const failed: Array<string> = [];

  yield* Effect.forEach(
    [...byRepo].toSorted(([a], [b]) => a.localeCompare(b)),
    ([repo, prs]) =>
      Effect.forEach(prs, (pr) => takeOver(pr, { root, settings, dryRun }), {
        discard: true,
      }).pipe(
        Effect.catchCause((cause) =>
          RunLog.warn(`${repo}: ${reason(cause)}`).pipe(
            Effect.andThen(Effect.sync(() => failed.push(repo))),
          ),
        ),
      ),
    { concurrency: 4, discard: true },
  );

  if (failed.length > 0)
    return yield* new ConsumersFailed({
      action: "take over Renovate updates in",
      repos: failed.toSorted(),
    });
});
