/**
 * How long each repository's CI takes on a push, kept between runs so CI is
 * watched at a pace that fits it: a quick workflow is looked at often, a slow
 * one is left alone until it's nearly done. Every run Upkeep reads, in ci or
 * while watching a push, adds what it took, so the store fills itself at no
 * extra cost. Agents are told the same pace, since `gh run watch` polls every
 * three seconds unless told otherwise.
 */
import type { Workflow } from "@timmo001/effect-gh";
import {
  Config,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Random,
  Schema,
} from "effect";

/** A workflow run as GitHub's REST API has it, with its timings. */
export const ApiRun = Schema.Struct({
  id: Schema.Number,
  run_attempt: Schema.Number,
  name: Schema.NullOr(Schema.String),
  display_title: Schema.String,
  head_branch: Schema.NullOr(Schema.String),
  head_sha: Schema.String,
  status: Schema.NullOr(Schema.String),
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  event: Schema.String,
  run_started_at: Schema.optionalKey(Schema.String),
  updated_at: Schema.String,
});

export type ApiRun = typeof ApiRun.Type;

/** A page of `repos/{repo}/actions/runs`. */
export const ApiRuns = Schema.Struct({ workflow_runs: Schema.Array(ApiRun) });

/** A REST run in the shape `gh run list` gives it. */
export const toRun = (run: ApiRun): Workflow.Run => ({
  databaseId: run.id,
  attempt: run.run_attempt,
  headBranch: run.head_branch,
  headSha: run.head_sha,
  status: run.status ?? "queued",
  conclusion: run.conclusion,
  url: run.html_url,
  workflowName: run.name,
  name: run.display_title,
  event: run.event,
});

/** How many of each workflow's latest runs are kept. */
const kept = 10;

const Sample = Schema.Struct({ id: Schema.Number, seconds: Schema.Number });

/** Each workflow's latest passing push runs, newest first. */
const Timings = Schema.Record(Schema.String, Schema.Array(Sample));

type Timings = typeof Timings.Type;

const fileOf = (repo: string) =>
  Config.String("XDG_CACHE_HOME").pipe(
    Config.orElse(() =>
      Config.String("HOME").pipe(Config.map((home) => `${home}/.cache`)),
    ),
    Config.map((root) => `${root}/upkeep/ci-timings/${repo}.json`),
  );

const read = Effect.fnUntraced(function* (repo: string) {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.readFileString(yield* fileOf(repo)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Timings))),
    Effect.orElseSucceed((): Timings => ({})),
  );
});

/** What a passing push run took, or `undefined` for any other run. */
const sampleOf = (run: ApiRun) => {
  if (
    run.event !== "push" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.name === null ||
    run.run_started_at === undefined
  )
    return undefined;

  const seconds =
    (Date.parse(run.updated_at) - Date.parse(run.run_started_at)) / 1000;

  return Number.isFinite(seconds) && seconds > 0
    ? { workflow: run.name, sample: { id: run.id, seconds } }
    : undefined;
};

/**
 * Add what a repository's passing push runs took. Two runs recording the same
 * repository at once can lose a sample, never the file.
 */
export const record = Effect.fnUntraced(
  function* (repo: string, runs: ReadonlyArray<ApiRun>) {
    const samples = runs.flatMap((run) => sampleOf(run) ?? []);

    if (samples.length === 0) return;

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* fileOf(repo);

    const timings = new Map(Object.entries(yield* read(repo)));

    for (const { workflow, sample } of samples) {
      const earlier = timings.get(workflow) ?? [];

      if (earlier.some(({ id }) => id === sample.id)) continue;

      timings.set(
        workflow,
        [...earlier, sample].toSorted((a, b) => b.id - a.id).slice(0, kept),
      );
    }

    const temporary = `${file}.${yield* Random.nextIntBetween(0, 1e9)}.tmp`;

    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(
      temporary,
      JSON.stringify(Object.fromEntries(timings)),
    );
    yield* fs.rename(temporary, file);
  },
  (effect) => Effect.ignore(effect),
);

const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/**
 * How long a push's CI usually takes in a repository: the slowest workflow's
 * median, since the push is done when that one is. None until a run is known.
 */
export const typical = (repo: string) =>
  read(repo).pipe(
    Effect.map((timings) =>
      Object.values(timings)
        .filter((samples) => samples.length > 0)
        .map((samples) => median(samples.map(({ seconds }) => seconds))),
    ),
    Effect.map((medians) =>
      medians.length === 0
        ? Option.none()
        : Option.some(Duration.seconds(Math.round(Math.max(...medians)))),
    ),
  );

/** How to watch a push's CI. */
export interface Pace {
  /** How long after the push to look first. */
  readonly first: Duration.Duration;
  /** How long to wait between looks after that. */
  readonly every: Duration.Duration;
  /** How long to watch before giving up. */
  readonly within: Duration.Duration;
}

const clamp = (
  value: Duration.Duration,
  minimum: Duration.Duration,
  maximum: Duration.Duration,
) => Duration.clamp(value, { minimum, maximum });

/**
 * The pace for CI that usually takes `usual`: the first look when most of it
 * should be done, then a look every eighth of it, between half a minute and
 * two minutes. Unknown CI is looked at every minute.
 */
export const pace = (usual: Option.Option<Duration.Duration>): Pace =>
  Option.match(usual, {
    onNone: () => ({
      first: Duration.seconds(30),
      every: Duration.minutes(1),
      within: Duration.minutes(30),
    }),
    onSome: (usual) => ({
      first: clamp(
        Duration.times(usual, 0.75),
        Duration.seconds(30),
        Duration.minutes(20),
      ),
      every: clamp(
        Duration.divideUnsafe(usual, 8),
        Duration.seconds(30),
        Duration.minutes(2),
      ),
      within: clamp(
        Duration.times(usual, 3),
        Duration.minutes(30),
        Duration.hours(2),
      ),
    }),
  });

/**
 * What an agent is told about watching CI in each repository, so it doesn't
 * poll every few seconds.
 */
export const advice = Effect.fnUntraced(function* (
  repos: ReadonlyArray<string>,
) {
  const known = yield* Effect.forEach(repos, (repo) =>
    typical(repo).pipe(
      Effect.map((usual) => ({
        repo,
        usual,
        every: Math.round(Duration.toSeconds(pace(usual).every)),
      })),
    ),
  );

  const lines = known.map(({ repo, usual, every }) =>
    Option.match(usual, {
      onNone: () =>
        `${repo}'s CI has no known timing, so look every ${every} seconds`,
      onSome: (usual) =>
        `${repo}'s CI usually takes about ${Duration.format(usual)}, so look every ${every} seconds`,
    }),
  );

  return [
    "When you watch CI, pace it to save GitHub's rate limit, which is shared with everything else on the account: use `gh run watch <run> --interval <seconds>` or look with `gh run list`, never polling every few seconds.",
    ...lines.map((line) => `- ${line}.`),
  ].join("\n");
});
