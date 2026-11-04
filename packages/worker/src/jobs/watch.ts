/**
 * The watch job: read the commits on each tracked repository's default branch
 * from the last 48 hours and add the ones the inbox doesn't have yet, so it
 * shows what happened outside Upkeep's own runs. Renovate's and Dependabot's
 * commits are dependency updates, grouped by update across repositories; the
 * rest are grouped by repository and day. A commit is routine when it only
 * moves versions, lockfiles, pins or tool versions.
 */
import { Api } from "@timmo001/effect-gh";
import type { Api as UpkeepApi, Domain } from "@upkeep/api";
import { Clock, Effect, Schema } from "effect";
import { Reporter, summary } from "../Reporter";
import * as RunLog from "../RunLog";
import { reason } from "./bump";

/** How far back each run looks; commits the inbox has are skipped. */
const lookbackHours = 48;

const User = Schema.Struct({ login: Schema.String });

const Commit = Schema.Struct({
  sha: Schema.String,
  html_url: Schema.String,
  commit: Schema.Struct({
    message: Schema.String,
    committer: Schema.NullOr(Schema.Struct({ date: Schema.String })),
  }),
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  parents: Schema.Array(Schema.Struct({ sha: Schema.String })),
});

type Commit = typeof Commit.Type;

const CommitFiles = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      filename: Schema.String,
      patch: Schema.optionalKey(Schema.String),
    }),
  ),
});

/** A file a commit touched, and its diff when GitHub sends one. */
export interface Touched {
  readonly filename: string;
  readonly patch?: string;
}

const lockfile =
  /(^|\/)(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|uv\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|flake\.lock|mise\.lock)$/;

const toolFile =
  /(^|\/)(\.?mise\.toml|\.tool-versions|tooling\.ya?ml|renovate\.json5?|\.renovaterc(\.json)?)$/;

const workflow = /(^\.github\/workflows\/.+|(^|\/)action)\.ya?ml$/;

const manifest =
  /(^|\/)(package\.json|Cargo\.toml|go\.mod|pyproject\.toml|requirements[\w.-]*\.txt)$/;

/** A changed line that only moves a version or a pin. */
const versionLine = [
  // package.json: "name": "^1.2.3"
  /^\s*"[^"]+":\s*"[^"]*",?\s*$/,
  // a workflow step's action pin: uses: owner/action@sha # v1
  /^\s*-?\s*uses:\s*\S+@\S+(\s*#.*)?$/,
  // Cargo.toml and pyproject.toml: name = "1.2", or name = { version = "1.2" }
  /^\s*[\w.-]+\s*=\s*("[^"]*"|\{[^}]*version[^}]*\})\s*,?\s*$/,
  // pyproject.toml lists: "name>=1.2",
  /^\s*"[\w.[\]-]+\s*[<>=~!]=?[^"]*",?\s*$/,
  // requirements files: name==1.2
  /^\s*[\w.[\]-]+\s*[<>=~!]=\s*[\w.*+!-]+\s*$/,
  // go.mod: require module v1.2.3
  /^\s*(require\s+)?\S+\s+v\S+(\s*\/\/.*)?$/,
];

/** The lines a diff adds or removes, without the file headers. */
const changedLines = (patch: string) =>
  patch
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") || line.startsWith("-")) &&
        !line.startsWith("+++") &&
        !line.startsWith("---"),
    )
    .map((line) => line.slice(1))
    .filter((line) => line.trim() !== "");

/**
 * Whether a commit is routine: every file it touched is a lockfile, a tool or
 * updater config, or a manifest or workflow whose diff only moves versions.
 */
export const routine = (files: ReadonlyArray<Touched>) =>
  files.length > 0 &&
  files.every(({ filename, patch }) => {
    if (lockfile.test(filename) || toolFile.test(filename)) return true;

    if (!workflow.test(filename) && !manifest.test(filename)) return false;

    // Without a diff, such as one too big for GitHub to send, it's not clear.
    if (patch === undefined) return false;

    return changedLines(patch).every((line) =>
      versionLine.some((pattern) => pattern.test(line)),
    );
  });

const bots = /\[bot\]$|^(renovate|dependabot)$/i;

/** A subject without its pull request number, so the same update matches. */
const withoutNumber = (subject: string) => subject.replace(/\s*\(#\d+\)$/, "");

/** Where a commit goes in the inbox, from who made it and when. */
export const place = (
  repo: string,
  commit: Commit,
  touched: ReadonlyArray<Touched>,
  you: string,
): Domain.Change => {
  const subject = commit.commit.message.split("\n")[0] ?? commit.sha;
  const login = commit.author?.login ?? "";
  const at = Date.parse(commit.commit.committer?.date ?? "") || 0;
  const name = repo.split("/").at(-1) ?? repo;
  const day = new Date(at).toISOString().slice(0, 10);

  const base = {
    repo,
    sha: commit.sha,
    subject,
    url: commit.html_url,
    at,
    routine: routine(touched),
  };

  if (bots.test(login)) {
    const update = withoutNumber(subject);

    return {
      ...base,
      group: `update:${update}`,
      title: update,
      kind: "update",
    };
  }

  const yours = login.toLowerCase() === you.toLowerCase();

  return {
    ...base,
    group: `${yours ? "you" : "commit"}:${repo.toLowerCase()}:${day}`,
    title: yours ? `Your commits to ${name}` : `Commits to ${name}`,
    kind: "commit",
    you: yours,
  };
};

/** One repository's commits since `since`, leaving out merge commits. */
const commitsOf = (repo: string, since: string) =>
  Api.pages(
    {
      endpoint: `repos/${repo}/commits`,
      method: "GET",
      query: { since, per_page: 100 },
    },
    Schema.Array(Commit),
  ).pipe(
    Effect.map((pages) =>
      pages
        .flat()
        .filter((commit) => commit.parents.length <= 1)
        .map((commit) => ({ repo, commit })),
    ),
  );

export const watch = Effect.fnUntraced(function* () {
  const reporter = yield* Reporter;
  const repos = yield* reporter.repos();
  const { login } = yield* Api.json({ endpoint: "user", method: "GET" }, User);
  const now = yield* Clock.currentTimeMillis;

  const since = new Date(now - lookbackHours * 3_600_000).toISOString();

  yield* RunLog.info(
    `Reading the last ${lookbackHours} hours of commits in ${repos.length} repositories`,
  );

  const failed: Array<string> = [];

  const found = (yield* Effect.forEach(
    repos,
    (repo) =>
      commitsOf(repo, since).pipe(
        Effect.catchCause((cause) =>
          RunLog.warn(`${repo}: ${reason(cause)}`).pipe(
            Effect.andThen(Effect.sync(() => failed.push(repo))),
            Effect.as([]),
          ),
        ),
      ),
    { concurrency: 4 },
  )).flat();

  const known = new Set(
    (yield* reporter.known(
      found.map(({ repo, commit }) => ({ repo, sha: commit.sha })),
    )).map(
      (ref: UpkeepApi.CommitRef) => `${ref.repo.toLowerCase()}@${ref.sha}`,
    ),
  );

  const fresh = found.filter(
    ({ repo, commit }) => !known.has(`${repo.toLowerCase()}@${commit.sha}`),
  );

  // Only new commits are read in full, for the files they touched.
  const changes = yield* Effect.forEach(
    fresh,
    ({ repo, commit }) =>
      Api.json(
        { endpoint: `repos/${repo}/commits/${commit.sha}`, method: "GET" },
        CommitFiles,
      ).pipe(
        Effect.map(({ files }) => place(repo, commit, files, login)),
        Effect.catchCause((cause) =>
          RunLog.warn(
            `${repo}: couldn't read ${commit.sha.slice(0, 7)}: ${reason(cause)}`,
          ).pipe(Effect.as(null)),
        ),
      ),
    { concurrency: 4 },
  );

  const added = yield* reporter.seen(
    changes.filter((change) => change !== null),
  );

  yield* summary(
    `Added ${added} of ${found.length} commits to the inbox${failed.length > 0 ? `, couldn't read ${failed.length} repositories` : ""}`,
  );

  // One repository GitHub won't answer for is left for the next run; none
  // answering is worth a heal.
  if (repos.length > 0 && failed.length === repos.length) {
    return yield* new WatchFailed({ count: failed.length });
  }
});

class WatchFailed extends Schema.TaggedError<WatchFailed>()("WatchFailed", {
  count: Schema.Number,
}) {
  override get message() {
    return `Couldn't read the commits of any of the ${this.count} repositories`;
  }
}
