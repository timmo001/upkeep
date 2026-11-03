/**
 * What the server and workers pass between them: jobs, their runs, each run's
 * log and the releases that start them. Times are milliseconds since the Unix
 * epoch.
 */
import { Schema } from "effect";

/** A job's ID, such as `releases`, used in commands and URLs. */
export const JobId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/),
);

export type JobId = typeof JobId.Type;

/**
 * Which of a worker's lanes runs a job. Each lane runs one run at a time, so
 * a job only waits behind the jobs in its own lane: `heal` for heals, which
 * can run a fix agent for a long while, `quick` for jobs that only call APIs,
 * and `repos` for jobs that clone and push to repositories, which take turns.
 */
export const Lane = Schema.Literals(["heal", "quick", "repos"]);

export type Lane = typeof Lane.Type;

/** A job the server knows, and what starts it besides a run button. */
export const Job = Schema.Struct({
  id: JobId,
  name: Schema.String,
  description: Schema.String,
  /** A cron expression it runs on, or null when it has no schedule. */
  schedule: Schema.NullOr(Schema.String),
  /** Whether a new release of one of the repositories starts it. */
  onRelease: Schema.Boolean,
  lane: Lane,
});

export interface Job extends Schema.Schema.Type<typeof Job> {}

/** A repository's release, as `owner/name` and its tag. */
export const Release = Schema.Struct({
  repo: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  tag: Schema.String.check(Schema.isMinLength(1)),
  url: Schema.String,
});

export interface Release extends Schema.Schema.Type<typeof Release> {}

/** What started a run. A heal is queued by the server for a failed run. */
export const Trigger = Schema.Literals([
  "schedule",
  "release",
  "manual",
  "heal",
]);

export type Trigger = typeof Trigger.Type;

/**
 * Where a run is: waiting for a worker, on one, or done. A run cancelled
 * while it was running is `cancelled`; one cancelled while queued is dropped.
 * A run that found nothing to do, such as a bump of a release with no
 * consumers, is `skipped`.
 */
export const RunState = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "skipped",
  "failed",
  "cancelled",
]);

export type RunState = typeof RunState.Type;

/** How a run can end. */
export const Outcome = Schema.Literals(["succeeded", "skipped", "failed"]);

export type Outcome = typeof Outcome.Type;

/** A repository as `owner/name`. */
export const RepoName = Schema.String.check(
  Schema.isPattern(/^[\w.-]+\/[\w.-]+$/),
);

/**
 * What a heal works on: Upkeep itself, or a consumer whose checks failed
 * after a bump. The agent's reach is set by it.
 */
export const Target = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("upkeep") }),
  Schema.Struct({ kind: Schema.Literal("consumer"), repo: RepoName }),
]);

export type Target = typeof Target.Type;

/** What the decision model chose for a failed run. */
export const HealDecision = Schema.Literals(["retry", "fix", "park", "ask"]);

export type HealDecision = typeof HealDecision.Type;

/**
 * A heal's record: the failed run, what the decision model chose and why,
 * the model and variant of the agent, what it did, its commit and its
 * OpenCode session. The worker fills it in as the heal goes.
 */
export const Heal = Schema.Struct({
  /** The failed or lost run. */
  of: Schema.String,
  /** That run's job. */
  job: JobId,
  target: Target,
  decision: Schema.NullOr(HealDecision),
  reason: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  variant: Schema.NullOr(Schema.String),
  actions: Schema.Array(Schema.String),
  commit: Schema.NullOr(Schema.String),
  session: Schema.NullOr(Schema.String),
  /** The failure's issue in triage, when the server reports to one. */
  issue: Schema.NullOr(Schema.String),
});

export interface Heal extends Schema.Schema.Type<typeof Heal> {}

/**
 * The same failure, or one like it, from triage: its title, where it stands,
 * and its notes, such as how it was fixed.
 */
export const Precedent = Schema.Struct({
  title: Schema.String,
  state: Schema.String,
  notes: Schema.Array(Schema.String),
});

export interface Precedent extends Schema.Schema.Type<typeof Precedent> {}

/**
 * A job the server stopped queueing until it's unparked, and why. Resolving
 * its triage issue, when it has one, unparks it.
 */
export const Parked = Schema.Struct({
  reason: Schema.String,
  at: Schema.Finite,
  issue: Schema.NullOr(Schema.String),
});

export interface Parked extends Schema.Schema.Type<typeof Parked> {}

export const Run = Schema.Struct({
  id: Schema.String,
  job: JobId,
  trigger: Trigger,
  /** The release it's for, when a release started it or was given. */
  release: Schema.NullOr(Release),
  state: RunState,
  /** The worker that took it. */
  worker: Schema.NullOr(Schema.String),
  queuedAt: Schema.Finite,
  startedAt: Schema.NullOr(Schema.Finite),
  finishedAt: Schema.NullOr(Schema.Finite),
  /** Why it failed. */
  error: Schema.NullOr(Schema.String),
  /** What a heal run is healing and what it did, or null for other jobs. */
  heal: Schema.NullOr(Heal),
});

export interface Run extends Schema.Schema.Type<typeof Run> {}

/** A job with its latest run, for a status list. */
export const JobStatus = Schema.Struct({
  ...Job.fields,
  lastRun: Schema.NullOr(Run),
  /** Set while the job is parked. */
  parked: Schema.NullOr(Parked),
});

export interface JobStatus extends Schema.Schema.Type<typeof JobStatus> {}

export const LogLevel = Schema.Literals(["info", "warn", "error"]);

export type LogLevel = typeof LogLevel.Type;

/** A line a worker sent for a run's log. */
export const LogEntry = Schema.Struct({
  at: Schema.Finite,
  level: LogLevel,
  message: Schema.String,
});

export interface LogEntry extends Schema.Schema.Type<typeof LogEntry> {}

/** A line of a run's log, numbered from 1 in the order it arrived. */
export const LogLine = Schema.Struct({
  seq: Schema.Int,
  ...LogEntry.fields,
});

export interface LogLine extends Schema.Schema.Type<typeof LogLine> {}
