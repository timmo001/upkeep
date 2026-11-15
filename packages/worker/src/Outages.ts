/**
 * GitHub outages. GitHub often goes down in part: Git while the API is up, or
 * Issues while pushes still work. When a run fails, the worker checks the
 * parts of GitHub its job uses with a small read of each, and a part that
 * doesn't answer is down: the run waits for it rather than failing, and new
 * runs wait while the API is down. Nothing is checked before a step, so a
 * push is never held up. GitHub's status page only adds to the log, since it
 * can say a part is down when it works, or still say so once it's back.
 */
import {
  Api,
  GhCommandError,
  GhTimeoutError,
  Graphql,
  isRateLimited,
  isTransient,
  type Gh,
  type GhError,
} from "@timmo001/effect-gh";
import { Catalogue } from "@upkeep/api";
import { Clock, Duration, Effect, Option, Schema, Stream } from "effect";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as RunLog from "./RunLog";

export const parts = [
  "git",
  "rest",
  "graphql",
  "issues",
  "pulls",
  "actions",
] as const;

/** A part of GitHub a job can find down. */
export type Part = (typeof parts)[number];

/** A part as people read it. */
export const names: Readonly<Record<Part, string>> = {
  git: "Git",
  rest: "REST API",
  graphql: "GraphQL API",
  issues: "Issues",
  pulls: "Pull requests",
  actions: "Actions",
};

/** The longest a run waits for GitHub before it ends as GitHub down. */
export const maxWait = Duration.hours(2);

/** How often a part that's down is checked again. */
export const checkEvery = Duration.minutes(2);

/** The parts each job uses, past the REST API every job does. */
const extra = new Map<string, ReadonlyArray<Part>>([
  [Catalogue.releases.id, ["graphql"]],
  [Catalogue.unreleased.id, ["git"]],
  [Catalogue.labels.id, ["graphql", "issues"]],
  [Catalogue.bump.id, ["git", "pulls", "actions"]],
  [Catalogue.stalledUpdates.id, ["pulls"]],
  [Catalogue.drift.id, ["git"]],
  [Catalogue.driftReview.id, ["git"]],
  [Catalogue.sync.id, ["git", "pulls"]],
  [Catalogue.deps.id, ["git", "pulls"]],
  [Catalogue.ci.id, ["actions"]],
  [Catalogue.watch.id, ["pulls"]],
  [Catalogue.skillConsumers.id, ["git", "pulls"]],
  [Catalogue.skillUpdates.id, ["git"]],
  [Catalogue.skillChange.id, ["git"]],
  [Catalogue.change.id, ["git", "pulls"]],
  [Catalogue.attention.id, ["graphql", "issues", "pulls"]],
  [Catalogue.attentionContext.id, ["graphql"]],
]);

/**
 * The parts of GitHub a job uses. A machine job pulls and installs from
 * GitHub, so it uses Git, as does a job this worker doesn't know.
 */
export const uses = (job: string): ReadonlyArray<Part> => {
  const known = Catalogue.jobs.find((each) => each.id === job);

  const own =
    extra.get(job) ??
    (known === undefined || known.machine === true ? ["git"] : []);

  return parts.filter((part) => part === "rest" || own.includes(part));
};

/**
 * A public repository every check reads, so a check never depends on what
 * the run's login can see. Any answer, even a refusal, means the part is up.
 */
const checked = "cli/cli";

const timeout = Duration.seconds(30);

/**
 * Whether gh got no answer from GitHub: it timed out, the network failed, it
 * got a 5xx, or it printed nothing, as when it's cut off. A spent rate limit
 * is an answer, which the rate limit handling waits out.
 */
const unanswered = (error: GhError | Graphql.ResponseError) =>
  error instanceof GhTimeoutError ||
  (error instanceof GhCommandError &&
    !isRateLimited(error) &&
    (isTransient(error) ||
      (error.stderr.trim() === "" && error.stdout.trim() === "")));

const read = (endpoint: string) =>
  Api.empty({ endpoint, method: "GET", options: { timeout } });

/** Whether `git ls-remote` reaches GitHub. */
const git = Effect.scoped(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const handle = yield* spawner.spawn(
      ChildProcess.make(
        "git",
        ["ls-remote", `https://github.com/${checked}`, "HEAD"],
        {
          stdin: "ignore",
          extendEnv: true,
          env: { GIT_TERMINAL_PROMPT: "0" },
        },
      ),
    );

    const [, , exitCode] = yield* Effect.all(
      [
        Stream.runDrain(handle.stdout),
        Stream.runDrain(handle.stderr),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );

    return Number(exitCode) === 0;
  }),
).pipe(
  Effect.timeout(timeout),
  Effect.orElseSucceed(() => false),
);

/** Whether a part of GitHub answers, as the run's login. */
export const probe = (
  part: Part,
): Effect.Effect<
  boolean,
  never,
  Gh | ChildProcessSpawner.ChildProcessSpawner
> => {
  if (part === "git") return git;

  const request =
    part === "graphql"
      ? Graphql.query(
          "query { rateLimit { remaining } }",
          undefined,
          Schema.Unknown,
          {
            timeout,
          },
        )
      : read(
          {
            rest: `repos/${checked}`,
            issues: `repos/${checked}/issues?per_page=1`,
            pulls: `repos/${checked}/pulls?per_page=1`,
            actions: `repos/${checked}/actions/runs?per_page=1`,
          }[part],
        );

  return request.pipe(
    Effect.as(true),
    Effect.catch((error) => Effect.succeed(!unanswered(error))),
  );
};

/** The first of `wanted` that's down, checking them side by side. */
export const down = Effect.fnUntraced(function* (wanted: ReadonlyArray<Part>) {
  const up = yield* Effect.forEach(wanted, probe, { concurrency: "unbounded" });

  return Option.fromUndefinedOr(wanted.find((_, index) => !up[index]));
});

/** The status page's component for each part. */
const components: Readonly<Record<Part, string>> = {
  git: "Git Operations",
  rest: "API Requests",
  graphql: "API Requests",
  issues: "Issues",
  pulls: "Pull Requests",
  actions: "Actions",
};

const Components = Schema.Struct({
  components: Schema.Array(
    Schema.Struct({ name: Schema.String, status: Schema.String }),
  ),
});

/**
 * What githubstatus.com says about a part, such as `major outage`, or none
 * when it lists no problem or can't be read.
 */
const reported = (part: Part) =>
  HttpClient.get("https://www.githubstatus.com/api/v2/components.json").pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(Components)),
    Effect.map(({ components: listed }) =>
      Option.fromUndefinedOr(
        listed.find(({ name }) => name === components[part])?.status,
      ).pipe(
        Option.filter((status) => status !== "operational"),
        Option.map((status) => status.replaceAll("_", " ")),
      ),
    ),
    Effect.timeout(timeout),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

/** A line for the log on what the status page says about a part. */
export const statusPage = (part: Part) =>
  reported(part).pipe(
    Effect.map(
      Option.match({
        onNone: () => "GitHub's status page doesn't list a problem with it yet",
        onSome: (status) =>
          `GitHub's status page has ${components[part]} as ${status}`,
      }),
    ),
  );

/**
 * Check a part every {@link checkEvery} until it's back, up to `until` in
 * epoch milliseconds. Returns whether it came back.
 */
export const waitBack = Effect.fnUntraced(function* (
  part: Part,
  until: number,
) {
  for (;;) {
    const now = yield* Clock.currentTimeMillis;

    if (now >= until) return false;

    yield* Effect.sleep(Duration.min(checkEvery, Duration.millis(until - now)));

    if (yield* probe(part)) return true;
  }
});

/**
 * Wait out an outage of the first of `wanted` that's down, for up to
 * {@link maxWait}, logging what's going on as `what`. Returns `up` when
 * nothing was down, `back` once the part that was is back, or `down` when
 * it's still down.
 */
export const waitOut = Effect.fnUntraced(function* (
  wanted: ReadonlyArray<Part>,
  what: string,
) {
  const found = yield* down(wanted);

  if (Option.isNone(found)) return "up" as const;

  const part = found.value;

  yield* RunLog.warn(
    `${what}: GitHub's ${names[part]} isn't answering, so waiting up to ${Duration.format(maxWait)} for it. ${yield* statusPage(part)}`,
  );

  const back = yield* waitBack(
    part,
    (yield* Clock.currentTimeMillis) + Duration.toMillis(maxWait),
  );

  if (back) yield* RunLog.info(`GitHub's ${names[part]} is back`);

  return back ? ("back" as const) : ("down" as const);
});

/** A run that stopped because a part of GitHub stayed down. */
export class GitHubDown extends Schema.TaggedError<GitHubDown>()("GitHubDown", {
  part: Schema.Literals(parts),
  minutes: Schema.Int,
  error: Schema.String,
}) {
  override get message() {
    return `GitHub's ${names[this.part]} was down for ${this.minutes} minutes, so the run stopped. It failed on: ${this.error}`;
  }
}
