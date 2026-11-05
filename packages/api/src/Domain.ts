/**
 * What the server and workers pass between them: jobs, their runs, each run's
 * log, the releases that start them and the inbox of what changed. Times are
 * milliseconds since the Unix epoch.
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
  /**
   * Whether it works on repositories, and so only on the ones tracked on the
   * server and opted into it.
   */
  tracked: Schema.Boolean,
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
 * A repository Upkeep looks after, and the jobs it's opted into. A job that
 * works on repositories leaves every other one alone.
 */
export const TrackedRepo = Schema.Struct({
  repo: RepoName,
  jobs: Schema.Array(JobId),
  addedAt: Schema.Finite,
  /**
   * Its name as people write it, such as `System Bridge`, from its README's
   * first heading. Null until the watch job has read it.
   */
  title: Schema.NullOr(Schema.String),
  /**
   * The name to show it by, over its title, such as `[HA] Card Energy
   * Breakdown`. Null to show the title.
   */
  name: Schema.NullOr(Schema.String),
  /**
   * Who set `name`: `you`, from the dashboard or CLI, or a `worker`, from
   * the command in its `names` setting. A worker never replaces your name.
   */
  namedBy: Schema.NullOr(Schema.Literals(["you", "worker"])),
});

export interface TrackedRepo extends Schema.Schema.Type<typeof TrackedRepo> {}

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

/**
 * A heal of a consumer held back by the heal limit, queued once that
 * consumer's heals free up. A later run of the job that reaches the consumer
 * drops it.
 */
export const WaitingHeal = Schema.Struct({
  /** The failed run it heals. */
  run: Schema.String,
  repo: Schema.String,
  at: Schema.Finite,
});

export interface WaitingHeal extends Schema.Schema.Type<typeof WaitingHeal> {}

/**
 * A job someone turned off: nothing queues it by schedule, release or heal
 * until it's resumed, though it can still be run by hand. Pausing `heal`
 * stops every heal.
 */
export const Paused = Schema.Struct({
  at: Schema.Finite,
  /** The admin who paused it. */
  by: Schema.String,
});

export interface Paused extends Schema.Schema.Type<typeof Paused> {}

/**
 * What an inbox entry is about: something that needs a person, a
 * first-party release reaching its consumers, a dependency update, a tool
 * moved by drift, a fix Upkeep pushed, or commits pushed outside Upkeep.
 */
export const EntryKind = Schema.Literals([
  "needs",
  "release",
  "update",
  "drift",
  "fix",
  "commit",
]);

export type EntryKind = typeof EntryKind.Type;

/**
 * A commit a run pushed, such as a bump, a drift update or a heal's fix, or
 * one the watch job found. The optional fields place it in the inbox.
 */
export const Change = Schema.Struct({
  repo: RepoName,
  sha: Schema.String,
  /** The commit message's first line. */
  subject: Schema.String,
  url: Schema.String,
  at: Schema.Finite,
  /**
   * Groups it with the same change in other repositories, such as
   * `release:timmo001/groundwork@0.9.33`. Without it, it's an entry of its own.
   */
  group: Schema.optionalKey(Schema.String),
  /** The group's title, such as `groundwork 0.9.33`. */
  title: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(EntryKind),
  /**
   * It only moved versions, lockfiles, pins or tool versions, with no code or
   * config change, so the inbox folds it away.
   */
  routine: Schema.optionalKey(Schema.Boolean),
  /** Pushed by the person Upkeep works for, rather than a bot. */
  you: Schema.optionalKey(Schema.Boolean),
});

export interface Change extends Schema.Schema.Type<typeof Change> {}

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
  /** What the run did, in a line or a short paragraph. */
  summary: Schema.NullOr(Schema.String),
  /** The commits it pushed, oldest first. */
  changes: Schema.Array(Change),
  /** It left something for a person, such as a fix an agent couldn't finish. */
  attention: Schema.Boolean,
});

export interface Run extends Schema.Schema.Type<typeof Run> {}

/** A change with the run that made it. */
export const RunChange = Schema.Struct({
  ...Change.fields,
  run: Schema.String,
  job: JobId,
});

export interface RunChange extends Schema.Schema.Type<typeof RunChange> {}

/**
 * What happened over a while, for the overview: how the runs ended, the
 * commits they pushed, newest first, and the runs that left something for a
 * person.
 */
export const Activity = Schema.Struct({
  since: Schema.Finite,
  runs: Schema.Struct({
    succeeded: Schema.Int,
    skipped: Schema.Int,
    failed: Schema.Int,
    cancelled: Schema.Int,
    heals: Schema.Int,
  }),
  changes: Schema.Array(RunChange),
  attention: Schema.Array(Run),
});

export interface Activity extends Schema.Schema.Type<typeof Activity> {}

/** One repository's part in an inbox entry, usually a commit. */
export const EntryItem = Schema.Struct({
  repo: RepoName,
  /** What happened there, such as the commit's subject. */
  text: Schema.String,
  sha: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  at: Schema.Finite,
});

export interface EntryItem extends Schema.Schema.Type<typeof EntryItem> {}

/**
 * One thing in the inbox: the same change across every repository it
 * reached, or something that needs a person. It's unread until it's read,
 * and comes back unread when something is added to it.
 */
export const Entry = Schema.Struct({
  id: Schema.String,
  kind: EntryKind,
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
  /** Where it points, such as a release's page. */
  url: Schema.NullOr(Schema.String),
  /** For something that needs a person: the job it holds up. */
  job: Schema.NullOr(JobId),
  /** The latest run behind it. */
  run: Schema.NullOr(Schema.String),
  /** The job of that run, while the run is kept. */
  runJob: Schema.NullOr(JobId),
  /** Only routine changes, so it's folded away. */
  routine: Schema.Boolean,
  /** Pushed by the person Upkeep works for. */
  you: Schema.Boolean,
  /** How many times it happened, such as how often a job was parked. */
  count: Schema.Int,
  items: Schema.Array(EntryItem),
  firstAt: Schema.Finite,
  lastAt: Schema.Finite,
  readAt: Schema.NullOr(Schema.Finite),
});

export interface Entry extends Schema.Schema.Type<typeof Entry> {}

/**
 * The inbox: every entry that's unread or changed since `since`, newest
 * first. Dismissed and settled entries are left out.
 */
export const Inbox = Schema.Struct({
  since: Schema.Finite,
  entries: Schema.Array(Entry),
});

export interface Inbox extends Schema.Schema.Type<typeof Inbox> {}

/** A job with its latest run, for a status list. */
export const JobStatus = Schema.Struct({
  ...Job.fields,
  lastRun: Schema.NullOr(Run),
  /** Set while the job is parked. */
  parked: Schema.NullOr(Parked),
  /** Set while the job is paused. */
  paused: Schema.NullOr(Paused),
  /** Heals of its consumers waiting on the heal limit; missing from older servers. */
  waiting: Schema.optionalKey(Schema.Array(WaitingHeal)),
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
