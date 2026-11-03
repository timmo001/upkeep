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

/** A job the server knows, and what starts it besides a run button. */
export const Job = Schema.Struct({
  id: JobId,
  name: Schema.String,
  description: Schema.String,
  /** A cron expression it runs on, or null when it has no schedule. */
  schedule: Schema.NullOr(Schema.String),
  /** Whether a new release of one of the repositories starts it. */
  onRelease: Schema.Boolean,
});

export interface Job extends Schema.Schema.Type<typeof Job> {}

/** A repository's release, as `owner/name` and its tag. */
export const Release = Schema.Struct({
  repo: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  tag: Schema.String.check(Schema.isMinLength(1)),
  url: Schema.String,
});

export interface Release extends Schema.Schema.Type<typeof Release> {}

/** What started a run. */
export const Trigger = Schema.Literals(["schedule", "release", "manual"]);

export type Trigger = typeof Trigger.Type;

/**
 * Where a run is: waiting for a worker, on one, or done. A run cancelled
 * while it was running is `cancelled`; one cancelled while queued is dropped.
 */
export const RunState = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export type RunState = typeof RunState.Type;

/** How a run can end. */
export const Outcome = Schema.Literals(["succeeded", "failed"]);

export type Outcome = typeof Outcome.Type;

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
});

export interface Run extends Schema.Schema.Type<typeof Run> {}

/** A job with its latest run, for a status list. */
export const JobStatus = Schema.Struct({
  ...Job.fields,
  lastRun: Schema.NullOr(Run),
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
