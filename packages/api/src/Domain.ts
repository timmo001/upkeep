/**
 * What the server and workers pass between them: jobs, their runs, each run's
 * log, the releases that start them and the inbox of what changed. Times are
 * milliseconds since the Unix epoch.
 */
import { Effect, Match, Schema } from "effect";

/** A job's ID, such as `releases`, used in commands and URLs. */
export const JobId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/),
);

export type JobId = typeof JobId.Type;

/**
 * Which of a worker's lanes runs a job. Each lane runs one run at a time, so
 * a job only waits behind the jobs in its own lane: `heal` for heals and
 * changes, which can run an agent for a long while, `quick` for jobs that
 * only call APIs,
 * `repos` for jobs that clone and push to repositories, which take turns, and
 * `command` for what the dashboard asks for, which a worker checks for often
 * so a click is answered in seconds, and `machine` for jobs that update the
 * worker's own machine.
 */
export const Lane = Schema.Literals([
  "heal",
  "quick",
  "repos",
  "command",
  "machine",
]);

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
  /**
   * Another job whose tracked repositories it works on, with no opt-in of its
   * own, such as `drift-review` with `drift`'s. Missing from older servers.
   */
  trackedAs: Schema.optionalKey(JobId),
  /**
   * Whether it runs once on every live worker rather than once overall, to
   * update the machine itself. Missing from older servers.
   */
  machine: Schema.optionalKey(Schema.Boolean),
});

export interface Job extends Schema.Schema.Type<typeof Job> {}

/** A repository's release, as `owner/name` and its tag. */
export const Release = Schema.Struct({
  repo: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  tag: Schema.String.check(Schema.isMinLength(1)),
  url: Schema.String,
});

export interface Release extends Schema.Schema.Type<typeof Release> {}

/** A repository as `owner/name`. */
export const RepoName = Schema.String.check(
  Schema.isPattern(/^[\w.-]+\/[\w.-]+$/),
);

/** The GitHub webhook events Upkeep takes. */
export const GitHubEventName = Schema.Literals([
  "release",
  "push",
  "workflow_run",
]);

export type GitHubEventName = typeof GitHubEventName.Type;

/** The most changed paths a push event carries. */
export const maxEventPaths = 300;

/**
 * What Upkeep reads from one GitHub webhook delivery, as the events Worker
 * queues it: a queue message is capped at 128 KB, and a push payload can be
 * far bigger, so only these fields are kept.
 */
export const GitHubEvent = Schema.Struct({
  /** GitHub's delivery ID, from `X-GitHub-Delivery`, which a repeat keeps. */
  delivery: Schema.String.check(Schema.isMinLength(1)),
  event: GitHubEventName,
  /** Such as `released` or `completed`; null for a push. */
  action: Schema.NullOr(Schema.String),
  repo: RepoName,
  defaultBranch: Schema.NullOr(Schema.String),
  /** Who caused it, by login. */
  sender: Schema.NullOr(Schema.String),
  /** For a push: the ref pushed, such as `refs/heads/main`. */
  ref: Schema.NullOr(Schema.String),
  /** For a push: the paths its commits added, changed or removed, at most `maxEventPaths`. */
  paths: Schema.Array(Schema.String),
  /** For a push: whether it changed more paths than `paths` holds. */
  truncated: Schema.Boolean,
  /** For a release: its tag and page. */
  release: Schema.NullOr(
    Schema.Struct({ tag: Schema.String, url: Schema.String }),
  ),
  /** For a workflow run: its workflow's name, branch and conclusion. */
  workflow: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      branch: Schema.NullOr(Schema.String),
      conclusion: Schema.NullOr(Schema.String),
    }),
  ),
  /** When the Worker received it. */
  at: Schema.Finite,
});

export interface GitHubEvent extends Schema.Schema.Type<typeof GitHubEvent> {}

/**
 * An installation token for the GitHub App, which a worker runs its jobs'
 * `gh` and `git` calls with, when it expires, and the account the App is
 * installed on, which stands in for `GET /user`, since the token can't read it.
 */
export const GitHubToken = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.Finite,
  account: Schema.String,
});

export interface GitHubToken extends Schema.Schema.Type<typeof GitHubToken> {}

/**
 * What started a run. A heal is queued by the server for a failed run, and
 * an `event` run by a GitHub event, such as a release being published.
 */
export const Trigger = Schema.Literals([
  "schedule",
  "release",
  "manual",
  "heal",
  "event",
]);

export type Trigger = typeof Trigger.Type;

/**
 * Where a run is: waiting for a worker, on one, or done. A run cancelled
 * while it was running is `cancelled`; one cancelled while queued is dropped.
 * A run that found nothing to do, such as a bump of a release with no
 * consumers, is `skipped`. One that found work only an agent can do, such as
 * a drift review, and handed it to a heal without anything failing, is
 * `handed-off`.
 */
export const RunState = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "skipped",
  "handed-off",
  "failed",
  "cancelled",
]);

export type RunState = typeof RunState.Type;

/** How a run can end. */
export const Outcome = Schema.Literals([
  "succeeded",
  "skipped",
  "handed-off",
  "failed",
]);

export type Outcome = typeof Outcome.Type;

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
 * What a heal works on: Upkeep itself, a consumer whose checks failed after
 * a bump, or several consumers the same run failed in, fixed together in one
 * agent session. The agent's reach is set by it.
 */
export const Target = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("upkeep") }),
  Schema.Struct({ kind: Schema.Literal("consumer"), repo: RepoName }),
  Schema.Struct({
    kind: Schema.Literal("consumers"),
    repos: Schema.Array(RepoName).check(Schema.isMinLength(2)),
  }),
]);

export type Target = typeof Target.Type;

/** The repositories a heal works on: none for Upkeep itself. */
export const targetRepos = (target: Target): ReadonlyArray<string> => {
  switch (target.kind) {
    case "upkeep":
      return [];
    case "consumer":
      return [target.repo];
    case "consumers":
      return target.repos;
  }
};

/** A heal's target as people read it, such as `timmo001/a and timmo001/b`. */
export const targetName = (target: Target) => {
  const repos = targetRepos(target);

  return Match.value(repos.length).pipe(
    Match.when(0, () => "Upkeep"),
    Match.when(1, () => repos[0] ?? ""),
    Match.orElse(
      () => `${repos.slice(0, -1).join(", ")} and ${repos.at(-1) ?? ""}`,
    ),
  );
};

/** An OpenCode model and its variant, as an agent runs it. */
export const AgentModel = Schema.Struct({
  model: Schema.String,
  variant: Schema.NullOr(Schema.String),
});

export interface AgentModel extends Schema.Schema.Type<typeof AgentModel> {}

/** An agent a worker can hand a fix to, and what it's for. */
export const Agent = Schema.Struct({
  ...AgentModel.fields,
  /** What the decision model reads to pick it. */
  for: Schema.String,
});

export interface Agent extends Schema.Schema.Type<typeof Agent> {}

/**
 * The agents a worker is set up with: where its heal decisions are made, as
 * `provider/model`, or null without a decision model, and its fix agents.
 * The first agent is the default and writes summaries; the last takes the
 * heals the decision model isn't sure about.
 */
export const AgentSetup = Schema.Struct({
  decisions: Schema.NullOr(Schema.String),
  agents: Schema.Array(Agent),
  /**
   * Whether it can open an agent for you from the Attention page, with
   * `attention.launch` in its settings. Older workers don't say.
   */
  launch: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
  /**
   * Whether it can open an agent's session for you, with
   * `attention.resume` in its settings. Older workers don't say.
   */
  resume: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
});

export interface AgentSetup extends Schema.Schema.Type<typeof AgentSetup> {}

/** A worker's agents, as it last told the server when it asked for work. */
export const WorkerAgents = Schema.Struct({
  worker: Schema.String,
  ...AgentSetup.fields,
  at: Schema.Finite,
});

export interface WorkerAgents extends Schema.Schema.Type<typeof WorkerAgents> {}

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
  /**
   * The decision model that chose, as `provider/model`, or null when nothing
   * chose and the fallback did.
   */
  decidedBy: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  variant: Schema.NullOr(Schema.String),
  actions: Schema.Array(Schema.String),
  commit: Schema.NullOr(Schema.String),
  session: Schema.NullOr(Schema.String),
  /** Where the agent worked, on the run's worker. */
  directory: Schema.NullOr(Schema.String),
  /**
   * Whether the worker shared the session with the server, so any worker
   * can open it.
   */
  shared: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
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

/**
 * The stretch of the inbox a summary covers: from `from` to `to`, and
 * whether it's only the unread entries in it or every entry.
 */
export const Period = Schema.Struct({
  from: Schema.Finite,
  to: Schema.Finite,
  unread: Schema.Boolean,
});

export interface Period extends Schema.Schema.Type<typeof Period> {}

const periodDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
});

/** A period's end as the summary names it, such as `5 November`. */
export const periodDay = (millis: number) => periodDate.format(millis);

/**
 * A period in words, such as "the unread entries from 29 October to 5
 * November" or "the last 7 days, 29 October to 5 November".
 */
export const describePeriod = (period: Period) => {
  const from = periodDay(period.from);
  const to = periodDay(period.to);
  const dates = from === to ? `on ${to}` : `from ${from} to ${to}`;

  if (period.unread) return `the unread entries ${dates}`;

  const days = Math.max(1, Math.round((period.to - period.from) / 86_400_000));

  return `the last ${days === 1 ? "day" : `${days} days`}, ${dates}`;
};

/**
 * Why an agent works on a skill: `merge` brings upstream changes into a
 * skill with local edits, `review` checks a skill against a new release of a
 * tool it covers, `release` does both for everything one tool release moves,
 * and `request` is a change you asked for.
 */
export const SkillWork = Schema.Literals([
  "merge",
  "review",
  "release",
  "request",
]);

export type SkillWork = typeof SkillWork.Type;

/**
 * Where a held skill change stands: the agent is `working` on it, it's
 * `waiting` for you, it's `applying` once approved, it `landed` on the
 * default branch, it's `stale` when its patch no longer applies or fails
 * validation, or it was `dropped`.
 */
export const SkillChangeState = Schema.Literals([
  "working",
  "waiting",
  "applying",
  "landed",
  "stale",
  "dropped",
]);

export type SkillChangeState = typeof SkillChangeState.Type;

/**
 * A change an agent made to a skill, held on the server for your approval,
 * so any worker can land it. Its session and checkout stay on the worker
 * that ran it.
 */
export const SkillChange = Schema.Struct({
  id: Schema.String,
  repo: RepoName,
  /** What it's about: a skill's name, or a tool release as `owner/name tag`. */
  title: Schema.String,
  /** The skills it touches. */
  skills: Schema.Array(Schema.String),
  work: SkillWork,
  /** What started it, such as the upstream SHA, the release or your prompt. */
  reason: Schema.String,
  /** The default branch's commit the patch is against. */
  base: Schema.NullOr(Schema.String),
  /** `git format-patch` output, or null until the agent commits. */
  patch: Schema.NullOr(Schema.String),
  subject: Schema.NullOr(Schema.String),
  /** What the agent said last. */
  summary: Schema.NullOr(Schema.String),
  session: Schema.NullOr(Schema.String),
  worker: Schema.String,
  directory: Schema.String,
  state: SkillChangeState,
  /** The commit it landed as. */
  commit: Schema.NullOr(Schema.String),
  /** Why it's stale, or what went wrong. */
  note: Schema.NullOr(Schema.String),
  at: Schema.Finite,
});

export interface SkillChange extends Schema.Schema.Type<typeof SkillChange> {}

/**
 * Where a skill comes from: written here (`authored`), imported unchanged
 * (`imported`) or with local edits (`adapted`), or installed from its origin
 * at a pinned SHA instead of committed (`external`).
 */
export const SkillSource = Schema.Literals([
  "authored",
  "imported",
  "adapted",
  "external",
]);

export type SkillSource = typeof SkillSource.Type;

/** A skill as the Skills page shows it. */
export const SkillInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  source: SkillSource,
  /** The upstream it's imported from, as a GitHub tree URL. */
  origin: Schema.NullOr(Schema.String),
  /** How the import stands against its upstream, from `skill-maintenance`. */
  upstream: Schema.NullOr(
    Schema.Struct({
      state: Schema.String,
      storedSha: Schema.NullOr(Schema.String),
      upstreamSha: Schema.NullOr(Schema.String),
      release: Schema.NullOr(Schema.String),
    }),
  ),
  localEdits: Schema.Array(Schema.String),
  /** The tools it covers, with the tag it was last reviewed against. */
  tools: Schema.Array(
    Schema.Struct({
      repo: Schema.String,
      reviewed: Schema.String,
      latest: Schema.NullOr(Schema.String),
      state: Schema.String,
    }),
  ),
  /** The repositories that keep a copy of it. */
  copies: Schema.Array(Schema.String),
  /** The last commits touching it, newest first. */
  commits: Schema.Array(
    Schema.Struct({
      sha: Schema.String,
      subject: Schema.String,
      at: Schema.Finite,
    }),
  ),
});

export interface SkillInfo extends Schema.Schema.Type<typeof SkillInfo> {}

/** The skills of one repository, as a worker last read them. */
export const SkillsSnapshot = Schema.Struct({
  repo: RepoName,
  skills: Schema.Array(SkillInfo),
  checkedAt: Schema.Finite,
});

export interface SkillsSnapshot extends Schema.Schema.Type<
  typeof SkillsSnapshot
> {}

/**
 * The Skills page: each repository's skills, their held changes, and when
 * each worker last asked for work, so the page can tell whether the one a
 * change ran on is up, and whether it can open an agent.
 */
export const SkillsPage = Schema.Struct({
  repos: Schema.Array(SkillsSnapshot),
  changes: Schema.Array(SkillChange),
  workers: Schema.Array(
    Schema.Struct({
      worker: Schema.String,
      at: Schema.Finite,
      launch: Schema.Boolean,
    }),
  ),
});

export interface SkillsPage extends Schema.Schema.Type<typeof SkillsPage> {}

/**
 * Something the server asks a worker to do once, on demand, as a run of the
 * `command` job: `mark-read` marks a GitHub notification thread read,
 * `start-agent` opens an agent on one worker, which only that one claims, and
 * `open-session` opens an agent's OpenCode session on the worker named.
 * The `skill-*` commands run as the `skill-change` job instead, `change` as
 * the `change` job, and `machine` names the worker a machine job's run is
 * for.
 */
export const Command = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("mark-read"),
    thread: Schema.String.check(Schema.isPattern(/^\d+$/)),
  }),
  /**
   * Open an agent on an Attention item, or a group's items, on the worker
   * named, with a brief of where it stands and your prompt. `repo` is the
   * repository it starts in; without it, the first item's.
   */
  Schema.Struct({
    kind: Schema.Literal("start-agent"),
    worker: Schema.String,
    url: Schema.NullOr(Schema.String),
    group: Schema.NullOr(Schema.String),
    repo: Schema.optionalKey(RepoName),
    prompt: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4000))),
  }),
  /**
   * Open an agent's OpenCode session, such as a heal's or a skill change's,
   * on the worker named, through its `attention.resume`. `directory` is
   * where the agent worked; on another worker, a session shared with the
   * server is imported into that worker's checkout of its repository first.
   * `title` names what it worked on.
   */
  Schema.Struct({
    kind: Schema.Literal("open-session"),
    worker: Schema.String,
    session: Schema.String,
    directory: Schema.String,
    title: Schema.String,
  }),
  /**
   * Have an agent work on a skill in its own checkout and hold what it
   * commits for your approval, on any worker.
   */
  Schema.Struct({
    kind: Schema.Literal("skill-start"),
    repo: RepoName,
    title: Schema.String,
    skills: Schema.Array(Schema.String),
    work: SkillWork,
    reason: Schema.String.check(Schema.isMaxLength(4000)),
  }),
  /** Land a held change: apply its patch, validate and push, on any worker. */
  Schema.Struct({
    kind: Schema.Literal("skill-approve"),
    change: Schema.String,
  }),
  /**
   * Ask for more on a held change. With `worker`, its session resumes there;
   * with null, any worker starts again from its patch.
   */
  Schema.Struct({
    kind: Schema.Literal("skill-revise"),
    change: Schema.String,
    comment: Schema.String.check(Schema.isMaxLength(4000)),
    worker: Schema.NullOr(Schema.String),
  }),
  /**
   * Open an agent on a held change in its checkout, on the worker it ran
   * on, through that worker's `attention.launch`.
   */
  Schema.Struct({
    kind: Schema.Literal("skill-open"),
    change: Schema.String,
    worker: Schema.String,
  }),
  /** Run a machine job on the worker named, which only that one claims. */
  Schema.Struct({
    kind: Schema.Literal("machine"),
    worker: Schema.String,
  }),
  /**
   * Have one agent make the change asked for across the repositories given,
   * in one session over checkouts side by side, checking and pushing each on
   * its own, on any worker.
   */
  Schema.Struct({
    kind: Schema.Literal("change"),
    repos: Schema.Array(RepoName).check(Schema.isMinLength(1)),
    prompt: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4000),
    ),
  }),
]);

export type Command = typeof Command.Type;

export const Run = Schema.Struct({
  id: Schema.String,
  job: JobId,
  trigger: Trigger,
  /** The release it's for, when a release started it or was given. */
  release: Schema.NullOr(Release),
  /**
   * The one repository it works on, when it was narrowed to one, such as by
   * an event from that repository. Null for every repository the job tracks.
   * Missing from older servers.
   */
  repo: Schema.optionalKey(Schema.NullOr(RepoName)),
  /** For a command run: what it's asked to do. */
  command: Schema.NullOr(Command),
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
  /** For a summary run: the stretch of the inbox it covers. */
  period: Schema.NullOr(Period),
  /** For a summary run: the model and variant that wrote it. */
  agent: Schema.NullOr(AgentModel),
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
    /** Missing from older servers. */
    handedOff: Schema.optionalKey(Schema.Int),
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
 * Who put an entry where it is: Upkeep's own call, a rule for its
 * repositories, or you moving it.
 */
export const EntryPlacer = Schema.Literals(["upkeep", "repository", "you"]);

export type EntryPlacer = typeof EntryPlacer.Type;

/**
 * A rule for every inbox entry from a repository: always a version bump, or
 * always worth reading. It holds for an entry when all its repositories
 * have the same rule.
 */
export const InboxRule = Schema.Struct({
  repo: RepoName,
  routine: Schema.Boolean,
  at: Schema.Finite,
});

export interface InboxRule extends Schema.Schema.Type<typeof InboxRule> {}

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
  /** Only routine changes, or moved there, so it's folded away. */
  routine: Schema.Boolean,
  /** Who decided `routine`. */
  placedBy: EntryPlacer,
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
  /** For a machine job: each worker's latest run. Missing from older servers. */
  machines: Schema.optionalKey(Schema.Array(Run)),
});

export interface JobStatus extends Schema.Schema.Type<typeof JobStatus> {}

/**
 * How Upkeep is as a whole: `ok`, `warning` while anything needs you, or
 * `degraded` while no worker is live to run anything.
 */
export const Health = Schema.Literals(["ok", "warning", "degraded"]);

export type Health = typeof Health.Type;

/** Something that needs you, pointing at where to deal with it. */
export const NeedsYou = Schema.Struct({
  kind: Schema.Literals(["needs", "skill-change"]),
  title: Schema.String,
  /**
   * The dashboard page it's on, relative to the dashboard: `runs/<id>`,
   * `jobs/<id>`, `skills`, or empty for the inbox.
   */
  path: Schema.String,
  at: Schema.Finite,
});

export interface NeedsYou extends Schema.Schema.Type<typeof NeedsYou> {}

/**
 * Upkeep's one status, which the CLI, the bar, the OpenCode footer and the
 * dashboard all read, so each shows the same count.
 */
export const Status = Schema.Struct({
  health: Health,
  /** One line saying what needs you, or that nothing does. */
  summary: Schema.String,
  /** What needs you, newest first. */
  needs: Schema.Array(NeedsYou),
  /** The parked jobs, which also show in `needs`. */
  parked: Schema.Array(JobId),
  /** The workers that asked for work in the last half hour. */
  workers: Schema.Array(Schema.String),
  at: Schema.Finite,
});

export interface Status extends Schema.Schema.Type<typeof Status> {}

/**
 * The Omarchy theme a desktop worker runs under: its name, such as `Tokyo
 * Night`, and the text of its `colors.toml`, which the dashboard maps itself.
 */
export const OmarchyTheme = Schema.Struct({
  name: Schema.String,
  colors: Schema.String,
});

export interface OmarchyTheme extends Schema.Schema.Type<typeof OmarchyTheme> {}

/** The latest Omarchy theme a worker sent, or none yet. */
export const DesktopTheme = Schema.Struct({
  theme: Schema.NullOr(OmarchyTheme),
});

export interface DesktopTheme extends Schema.Schema.Type<typeof DesktopTheme> {}

/**
 * A part of the server's state that a change touched: `runs` covers runs and
 * jobs, `log` a run's log, `inbox` the inbox and tracked repositories,
 * `workers` what the workers last said they're set up with, and `theme` the
 * desktop's Omarchy theme.
 */
export const Topic = Schema.Literals([
  "runs",
  "log",
  "inbox",
  "attention",
  "skills",
  "workers",
  "theme",
]);

export type Topic = typeof Topic.Type;

/**
 * Something changed on the server, for the dashboard to fetch again and a
 * worker waiting on work or a cancel to look again. `run` is the one run it
 * was about, when it was about one.
 */
export const StateChange = Schema.Struct({
  topic: Topic,
  run: Schema.optionalKey(Schema.String),
});

export interface StateChange extends Schema.Schema.Type<typeof StateChange> {}

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

/** What an attention item is on GitHub. */
export const AttentionKind = Schema.Literals(["pull", "issue", "notification"]);

export type AttentionKind = typeof AttentionKind.Type;

/**
 * Something GitHub says about an item, which decides its section. Most only
 * come up on your own pull requests and issues.
 */
export const SignalKind = Schema.Literals([
  /** Your review is requested. */
  "review-requested",
  /** A reviewer asked for changes on your pull request. */
  "changes-requested",
  /** Review threads on your pull request someone else spoke last in. */
  "unresolved",
  /** Someone else commented on your item after you. */
  "new-comment",
  /** You were mentioned. */
  "mentioned",
  "failing-checks",
  "conflicts",
  /** The base branch changed files your pull request touches. */
  "base-moved",
  /** Upkeep has a run for the repository that needs a person. */
  "upkeep",
  "approved",
  /**
   * Your pull request can go in and you can merge it: its checks pass, or it
   * has none, with no conflicts, no changes asked for, no required review
   * still to come, and no review waiting on anyone else unless it's approved.
   */
  "ready",
  "draft",
  /** Its notification is unread. */
  "unread",
]);

export type SignalKind = typeof SignalKind.Type;

/** A signal as a person reads it. */
export const signalLabel = (kind: SignalKind) =>
  ({
    "review-requested": "review requested",
    "changes-requested": "changes requested",
    unresolved: "unresolved threads",
    "new-comment": "new comment",
    mentioned: "mentioned",
    "failing-checks": "failing checks",
    conflicts: "conflicts",
    "base-moved": "base moved",
    upkeep: "Upkeep needs you",
    approved: "approved",
    ready: "ready to merge",
    draft: "draft",
    unread: "unread",
  })[kind];

export const Signal = Schema.Struct({
  kind: SignalKind,
  /** More about it, such as how many threads or which check failed. */
  detail: Schema.NullOr(Schema.String),
});

export interface Signal extends Schema.Schema.Type<typeof Signal> {}

/**
 * The shared status labels from timmo001/groundwork's conventions, as they
 * match without case, from what's most pressing to what's put off. An item
 * without one sits between Needs Research and Blocked, which waits on
 * something else, so there's nothing to do on it yet.
 */
export const statusLabels = [
  "needs decision",
  "in progress",
  "ready",
  "planned",
  "needs research",
  "blocked",
  "on hold",
  "future",
] as const;

export type StatusLabel = (typeof statusLabels)[number];

/** An item's status label, the most pressing when it has several. */
export const statusOf = (labels: ReadonlyArray<string>) =>
  statusLabels.find((status) =>
    labels.some((label) => label.toLowerCase() === status),
  ) ?? null;

/** Where an item sits on the Attention page, from its signals and age. */
export const AttentionSection = Schema.Literals([
  "needs-you",
  "blocked",
  "stale",
  "waiting",
  /** Your drafts, and your issues nobody else has taken part in. */
  "backlog",
  "watching",
]);

export type AttentionSection = typeof AttentionSection.Type;

/** An item's GitHub notification. */
export const AttentionNotification = Schema.Struct({
  id: Schema.String,
  /** Why GitHub sent it, such as `mention` or `review_requested`. */
  reason: Schema.String,
  unread: Schema.Boolean,
  updatedAt: Schema.Finite,
});

export interface AttentionNotification extends Schema.Schema.Type<
  typeof AttentionNotification
> {}

/** One pull request, issue or notification, as a worker found it. */
export const AttentionFound = Schema.Struct({
  /** Its page on GitHub, which it's known by. */
  url: Schema.String,
  kind: AttentionKind,
  repo: RepoName,
  number: Schema.NullOr(Schema.Int),
  title: Schema.String,
  author: Schema.NullOr(Schema.String),
  /** Opened by the person Upkeep works for. */
  yours: Schema.Boolean,
  /** Work rather than personal, from the worker's site patterns. */
  work: Schema.Boolean,
  /** The person Upkeep works for acted on it last. */
  youActedLast: Schema.Boolean,
  /** Someone other than its author, and not a bot, has taken part. */
  involved: Schema.Boolean,
  /** The latest activity by anyone but a bot. */
  activityAt: Schema.Finite,
  updatedAt: Schema.Finite,
  signals: Schema.Array(Signal),
  /** Its labels' names; empty from a worker older than labels. */
  labels: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  notification: Schema.NullOr(AttentionNotification),
  /** What can change it, so an unchanged item is left alone. */
  fingerprint: Schema.String,
});

export interface AttentionFound extends Schema.Schema.Type<
  typeof AttentionFound
> {}

/**
 * The context agent's one-line read of an item, such as "Waiting on the
 * December release". Until `recheckAt`, or until the item changes, it keeps
 * the item out of Going stale.
 */
export const AttentionNote = Schema.Struct({
  text: Schema.String,
  recheckAt: Schema.NullOr(Schema.Finite),
  /** The item's fingerprint when it was written, so a change shows it's old. */
  fingerprint: Schema.String,
  at: Schema.Finite,
});

export interface AttentionNote extends Schema.Schema.Type<
  typeof AttentionNote
> {}

/** An item as the Attention page shows it. */
export const AttentionItem = Schema.Struct({
  ...AttentionFound.fields,
  section: AttentionSection,
  firstSeen: Schema.Finite,
  /** When its signals or fingerprint last moved. */
  changedAt: Schema.Finite,
  /** Hidden until anything about it changes. */
  hidden: Schema.Boolean,
  /** The context agent's note, or null before its first. */
  note: Schema.NullOr(AttentionNote),
});

export interface AttentionItem extends Schema.Schema.Type<
  typeof AttentionItem
> {}

/** What moved on an item in one collection, for Since you last looked. */
export const AttentionChange = Schema.Struct({
  url: Schema.String,
  repo: RepoName,
  title: Schema.String,
  at: Schema.Finite,
  /** Each thing that moved, such as `New: failing checks`. */
  what: Schema.Array(Schema.String),
  /** It's closed or merged, or no longer involves you. */
  gone: Schema.Boolean,
  /** The group it was in when it went, for the agent's follow-up. */
  group: Schema.NullOr(Schema.String),
});

export interface AttentionChange extends Schema.Schema.Type<
  typeof AttentionChange
> {}

/**
 * A link GitHub keeps between two pull requests or issues, such as a pull
 * request and the issue it closes, an issue and its parent, or a stack.
 */
export const AttentionRelation = Schema.Struct({
  from: Schema.String,
  /** The other page, which may be one that isn't an item itself. */
  to: Schema.String,
});

export interface AttentionRelation extends Schema.Schema.Type<
  typeof AttentionRelation
> {}

/** How much a group of work is wanted now: pinned, kept an eye on, or put away. */
export const AttentionFocus = Schema.Literals(["today", "watching", "parked"]);

export type AttentionFocus = typeof AttentionFocus.Type;

/** Who put something on the page: GitHub's own links, you, or the agent. */
export const AttentionSource = Schema.Literals(["github", "you", "agent"]);

export type AttentionSource = typeof AttentionSource.Type;

/** An item put in a group. */
export const AttentionLink = Schema.Struct({
  /** The item's page on GitHub, kept even while the item is gone. */
  url: Schema.String,
  source: AttentionSource,
  /** The agent proposed it, and it's not accepted yet. */
  suggested: Schema.Boolean,
});

export interface AttentionLink extends Schema.Schema.Type<
  typeof AttentionLink
> {}

/** Something outside GitHub a group waits on, such as a release next month. */
export const AttentionWait = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  url: Schema.NullOr(Schema.String),
  /** When to look at it again. */
  recheckAt: Schema.NullOr(Schema.Finite),
  source: AttentionSource,
  createdAt: Schema.Finite,
});

export interface AttentionWait extends Schema.Schema.Type<
  typeof AttentionWait
> {}

/** One piece of work: items across repositories, and what it waits on. */
export const AttentionGroup = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  focus: AttentionFocus,
  notes: Schema.NullOr(Schema.String),
  source: AttentionSource,
  createdAt: Schema.Finite,
  items: Schema.Array(AttentionLink),
  waits: Schema.Array(AttentionWait),
  /**
   * The context agent's follow-up after one of its items went: what that
   * means for the rest, such as an issue to close or an item now unblocked.
   */
  followUp: Schema.NullOr(
    Schema.Struct({ text: Schema.String, at: Schema.Finite }),
  ),
});

export interface AttentionGroup extends Schema.Schema.Type<
  typeof AttentionGroup
> {}

/** Something you told the agent about an item or a group, and what it did. */
export const AttentionComment = Schema.Struct({
  id: Schema.String,
  /** The item it's about, or null for a group. */
  url: Schema.NullOr(Schema.String),
  /** The group it's about, or null for an item. */
  group: Schema.NullOr(Schema.String),
  text: Schema.String,
  createdAt: Schema.Finite,
  /** What the agent did about it, once it has. */
  outcome: Schema.NullOr(Schema.String),
  doneAt: Schema.NullOr(Schema.Finite),
});

export interface AttentionComment extends Schema.Schema.Type<
  typeof AttentionComment
> {}

/** A standing instruction for the agent, such as which threads to skip. */
export const AttentionRule = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  /** The comment it came from, or null when written as a rule. */
  comment: Schema.NullOr(Schema.String),
  createdAt: Schema.Finite,
});

export interface AttentionRule extends Schema.Schema.Type<
  typeof AttentionRule
> {}

/** The Attention page: every item, and what changed since you last looked. */
export const Attention = Schema.Struct({
  items: Schema.Array(AttentionItem),
  groups: Schema.Array(AttentionGroup),
  comments: Schema.Array(AttentionComment),
  rules: Schema.Array(AttentionRule),
  /** What moved since you last looked, and what went over the last week. */
  changes: Schema.Array(AttentionChange),
  /** Each tracked repository's latest release, and when Upkeep saw it. */
  releases: Schema.Array(
    Schema.Struct({ ...Release.fields, seenAt: Schema.Finite }),
  ),
  /** When you last looked before this visit, or null the first time. */
  since: Schema.NullOr(Schema.Finite),
  /** When a worker last sent what it found, or null before the first. */
  collectedAt: Schema.NullOr(Schema.Finite),
  /**
   * When a refresh can next queue a collection, or null when it can now or
   * one is already waiting or running.
   */
  refreshAt: Schema.NullOr(Schema.Finite),
  /** Whether it's work time, as the worker last said, or null when unknown. */
  workTime: Schema.NullOr(Schema.Boolean),
  /** Days without activity before an item is going stale. */
  staleDays: Schema.Int,
});

export interface Attention extends Schema.Schema.Type<typeof Attention> {}
