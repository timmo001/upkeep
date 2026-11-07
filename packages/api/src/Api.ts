/**
 * The server's HTTP API, shared by the server, its workers and the CLI so each
 * side encodes and decodes the same shapes. Admins read jobs and runs, start
 * runs and manage tracked repositories and tokens; workers take runs and
 * report on them.
 */
import { Context, Schema, Struct } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi,
} from "effect/http-api";
import {
  Activity,
  AgentModel,
  AgentSetup,
  Attention,
  AttentionComment,
  AttentionFocus,
  AttentionFound,
  // The HTTP group below already takes the name
  AttentionGroup as AttentionGroupSchema,
  AttentionRelation,
  AttentionRule,
  AttentionWait,
  Change,
  Command,
  Entry,
  Heal,
  HealDecision,
  Inbox,
  JobId,
  JobStatus,
  LogEntry,
  LogLine,
  Outcome,
  Parked,
  Period,
  Precedent,
  Release,
  RepoName,
  Run,
  RunState,
  SkillChange,
  SkillChangeState,
  SkillsPage,
  SkillsSnapshot,
  Status,
  TrackedRepo,
  WorkerAgents,
} from "./Domain";

/** The admin a request was authenticated as. */
export class CurrentAdmin extends Context.Service<
  CurrentAdmin,
  { readonly name: string }
>()("@upkeep/api/Api/CurrentAdmin") {}

/** The worker a request was authenticated as. */
export class CurrentWorker extends Context.Service<
  CurrentWorker,
  { readonly name: string }
>()("@upkeep/api/Api/CurrentWorker") {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class JobNotFound extends Schema.TaggedError<JobNotFound>()(
  "JobNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message() {
    return `There's no job ${this.id}`;
  }
}

/** A job that only runs for a release was queued without one. */
export class ReleaseRequired extends Schema.TaggedError<ReleaseRequired>()(
  "ReleaseRequired",
  { id: Schema.String },
  { httpApiStatus: 400 },
) {
  override get message() {
    return `${this.id} runs for a release; give one with --release`;
  }
}

/**
 * A run was narrowed to a repository the job can't be narrowed to: a job that
 * doesn't work on repositories, or one the repository isn't tracked for.
 */
export class RepoNotScopable extends Schema.TaggedError<RepoNotScopable>()(
  "RepoNotScopable",
  { id: Schema.String, repo: Schema.String, reason: Schema.String },
  { httpApiStatus: 400 },
) {
  override get message() {
    return `${this.id} can't run for ${this.repo}: ${this.reason}`;
  }
}

/**
 * The version of what a worker has to read from the server. Bump it whenever
 * a run gains a value an older worker can't decode, such as a new trigger, so
 * the server refuses older workers before handing them a run rather than
 * leaving it stranded until the lost-run sweep.
 */
export const protocol = 1;

/** A worker claimed work with an older protocol than the server's. */
export class WorkerOutdated extends Schema.TaggedError<WorkerOutdated>()(
  "WorkerOutdated",
  { worker: Schema.Int, server: Schema.Int },
  { httpApiStatus: 409 },
) {
  override get message() {
    return `This worker is older than the server (protocol ${this.worker}, the server's is ${this.server}), so it's given no runs until upkeep is updated here`;
  }
}

export class RunNotFound extends Schema.TaggedError<RunNotFound>()(
  "RunNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message() {
    return `There's no run ${this.id}`;
  }
}

export class GroupNotFound extends Schema.TaggedError<GroupNotFound>()(
  "GroupNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message() {
    return `There's no attention group ${this.id}`;
  }
}

export class EntryNotFound extends Schema.TaggedError<EntryNotFound>()(
  "EntryNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message() {
    return `There's no inbox entry ${this.id}`;
  }
}

export class SkillChangeNotFound extends Schema.TaggedError<SkillChangeNotFound>()(
  "SkillChangeNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message() {
    return `There's no skill change ${this.id}`;
  }
}

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()(
  "SessionNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message() {
    return `Session ${this.id} wasn't shared with the server`;
  }
}

/**
 * An agent's OpenCode session as `opencode session export` wrote it, and the
 * repository it worked in, so another worker can import and open it.
 */
export const SessionExport = Schema.Struct({
  repo: RepoName,
  export: Schema.String,
});

export interface SessionExport extends Schema.Schema.Type<
  typeof SessionExport
> {}

/** A held skill change as its worker sends it; the server adds its ID, the worker and the time. */
export const SkillChangeInput = SkillChange.mapFields(
  Struct.omit(["id", "worker", "at"]),
);

export interface SkillChangeInput extends Schema.Schema.Type<
  typeof SkillChangeInput
> {}

/** Move a held skill change on, such as once it's landed. */
export const SkillChangeStateUpdate = Schema.Struct({
  state: SkillChangeState,
  commit: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export interface SkillChangeStateUpdate extends Schema.Schema.Type<
  typeof SkillChangeStateUpdate
> {}

/** A worker reported on a run it isn't running, such as one that was lost. */
export class RunNotClaimed extends Schema.TaggedError<RunNotClaimed>()(
  "RunNotClaimed",
  { id: Schema.String, worker: Schema.String },
  { httpApiStatus: 409 },
) {
  override get message() {
    return `Run ${this.id} isn't running on ${this.worker}`;
  }
}

/** A run that's already ended, so there's nothing to cancel. */
export class RunFinished extends Schema.TaggedError<RunFinished>()(
  "RunFinished",
  { id: Schema.String, state: RunState },
  { httpApiStatus: 409 },
) {
  override get message() {
    return `Run ${this.id} has already ${this.state}`;
  }
}

/** A run that hasn't ended yet, so it can't be run again. */
export class RunGoing extends Schema.TaggedError<RunGoing>()(
  "RunGoing",
  { id: Schema.String, state: RunState },
  { httpApiStatus: 409 },
) {
  override get message() {
    return `Run ${this.id} is still ${this.state}`;
  }
}

/** A repository the server doesn't track. */
export class RepoNotTracked extends Schema.TaggedError<RepoNotTracked>()(
  "RepoNotTracked",
  { repo: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message() {
    return `${this.repo} isn't tracked`;
  }
}

/** Jobs a repository can't be opted into: unknown, or not working on repositories. */
export class UntrackedJobs extends Schema.TaggedError<UntrackedJobs>()(
  "UntrackedJobs",
  { jobs: Schema.Array(Schema.String) },
  { httpApiStatus: 400 },
) {
  override get message() {
    return `A repository can't be opted into ${this.jobs.join(", ")}: only jobs that work on repositories`;
  }
}

/** A cancelled run, and whether it was dropped from the queue before it ran. */
export const Cancelled = Schema.Struct({
  run: Run,
  dropped: Schema.Boolean,
});

export interface Cancelled extends Schema.Schema.Type<typeof Cancelled> {}

/** Changes to a heal's record; each given field replaces what's there. */
export const HealUpdate = Schema.Struct({
  decision: Schema.optionalKey(HealDecision),
  reason: Schema.optionalKey(Schema.String),
  decidedBy: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  variant: Schema.optionalKey(Schema.String),
  /** Added to the heal's actions. */
  action: Schema.optionalKey(Schema.String),
  commit: Schema.optionalKey(Schema.String),
  session: Schema.optionalKey(Schema.String),
  directory: Schema.optionalKey(Schema.String),
});

export interface HealUpdate extends Schema.Schema.Type<typeof HealUpdate> {}

/**
 * What a run reports as it goes: `summary` replaces its summary, `change` is
 * added to its changes, `attention` marks it as needing a person, and
 * `period` and `agent` set the stretch of the inbox a summary run covers and
 * the model that writes it.
 */
export const RunReport = Schema.Struct({
  summary: Schema.optionalKey(Schema.String),
  change: Schema.optionalKey(Change),
  attention: Schema.optionalKey(Schema.Boolean),
  period: Schema.optionalKey(Period),
  agent: Schema.optionalKey(AgentModel),
});

export interface RunReport extends Schema.Schema.Type<typeof RunReport> {}

/** What a token can do: an admin runs the server, a worker runs jobs. */
export const TokenScope = Schema.Literals(["admin", "worker"]);

export type TokenScope = typeof TokenScope.Type;

/** A token's name, which the server knows its holder by. */
export const TokenName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/),
);

/** A token's holder. The token itself is only shown when it's issued. */
export const Token = Schema.Struct({
  name: Schema.String,
  createdAt: Schema.Finite,
});

export interface Token extends Schema.Schema.Type<typeof Token> {}

export class TokenExists extends Schema.TaggedError<TokenExists>()(
  "TokenExists",
  { scope: TokenScope, holder: Schema.String },
  { httpApiStatus: 409 },
) {
  override get message() {
    return `There's already a ${this.scope} called ${this.holder}`;
  }
}

export class TokenNotFound extends Schema.TaggedError<TokenNotFound>()(
  "TokenNotFound",
  { scope: TokenScope, holder: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message() {
    return `There's no ${this.scope} called ${this.holder}`;
  }
}

export class AdminAuthorization extends HttpApiMiddleware.Service<
  AdminAuthorization,
  { provides: CurrentAdmin; requires: never }
>()("@upkeep/api/Api/AdminAuthorization", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized,
}) {}

export class WorkerAuthorization extends HttpApiMiddleware.Service<
  WorkerAuthorization,
  { provides: CurrentWorker; requires: never }
>()("@upkeep/api/Api/WorkerAuthorization", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized,
}) {}

/** The most runs one list returns. */
export const maxRuns = 200;

/** The most log lines one request carries, either way. */
export const maxLogLines = 1000;

/** How many of a failed run's last log lines a heal reads. */
export const healLogLines = 200;

/** The most releases one report carries. */
export const maxReleases = 1000;

/** The most commits one request to the inbox carries, either way. */
export const maxCommits = 500;

/**
 * How many days of read entries the inbox shows by default, for the
 * dashboard and the summary job alike.
 */
export const inboxDays = 7;

/** The most attention items one collection carries. */
export const maxAttention = 2000;

/** How old the attention job's last run is before a refresh runs it again. */
export const attentionRefreshMs = 5 * 60_000;

/**
 * What the attention job found: every item in scope. With `complete`, any
 * item it no longer found is gone, closed or no longer involving you; a run
 * that couldn't read everything leaves the rest as they were.
 */
export const AttentionSnapshot = Schema.Struct({
  items: Schema.Array(AttentionFound).pipe(
    Schema.check(Schema.isMaxLength(maxAttention)),
  ),
  /**
   * How the items tie together on GitHub, which the server forms groups
   * from. A worker without it leaves GitHub's groups as they were.
   */
  relations: Schema.optionalKey(
    Schema.Array(AttentionRelation).pipe(
      Schema.check(Schema.isMaxLength(maxAttention * 20)),
    ),
  ),
  complete: Schema.Boolean,
  /** Whether it's work time, from the worker's check, or null without one. */
  workTime: Schema.NullOr(Schema.Boolean),
  staleDays: Schema.Int.check(Schema.isGreaterThan(0)),
});

export interface AttentionSnapshot extends Schema.Schema.Type<
  typeof AttentionSnapshot
> {}

/** The most of each kind of answer one context run carries. */
export const maxContext = 200;

/**
 * What the context agent made of the items and groups it was given: a note
 * on each item, a follow-up on each group one of its items left, what it did
 * about each of your comments, and the links it made or suggests.
 */
export const AttentionContext = Schema.Struct({
  notes: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      text: Schema.String,
      recheckAt: Schema.NullOr(Schema.Finite),
      fingerprint: Schema.String,
    }),
  ).pipe(Schema.check(Schema.isMaxLength(maxContext))),
  followUps: Schema.Array(
    Schema.Struct({ group: Schema.String, text: Schema.String }),
  ).pipe(Schema.check(Schema.isMaxLength(maxContext))),
  comments: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      outcome: Schema.String,
      /** A standing instruction it found in the comment, kept as a rule. */
      rule: Schema.NullOr(Schema.String),
    }),
  ).pipe(Schema.check(Schema.isMaxLength(maxContext))),
  /**
   * Items to move into a group, or out of any with null. A suggestion only
   * lands on an item that isn't in a group yet, and waits to be accepted.
   */
  links: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      group: Schema.NullOr(Schema.String),
      suggested: Schema.Boolean,
    }),
  ).pipe(Schema.check(Schema.isMaxLength(maxContext))),
});

export interface AttentionContext extends Schema.Schema.Type<
  typeof AttentionContext
> {}

/** A tracked repository's title, from its README's first heading. */
export const RepoTitle = Schema.Struct({
  repo: RepoName,
  title: Schema.NullOr(Schema.String),
});

export interface RepoTitle extends Schema.Schema.Type<typeof RepoTitle> {}

/** A name to show a tracked repository by, from a worker's `names` command. */
export const RepoLabel = Schema.Struct({
  repo: RepoName,
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});

export interface RepoLabel extends Schema.Schema.Type<typeof RepoLabel> {}

/** A commit by its repository and SHA. */
export const CommitRef = Schema.Struct({ repo: RepoName, sha: Schema.String });

export interface CommitRef extends Schema.Schema.Type<typeof CommitRef> {}

export class JobsGroup extends HttpApiGroup.make("jobs")
  .add(
    HttpApiEndpoint.get("list", "/", {
      success: Schema.Array(JobStatus),
    }),
    /** Each worker's agents, as it last told the server, by worker name. */
    HttpApiEndpoint.get("agents", "/agents", {
      success: Schema.Array(WorkerAgents),
    }),
    /**
     * Queue a run, as the run button does. A run of the job for the same
     * release that's still waiting is returned instead of a second one. A job
     * that runs on releases needs one. With `repo`, the run only works on that
     * repository, and a waiting run for it or for every repository is
     * returned instead.
     */
    HttpApiEndpoint.post("run", "/:id/runs", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        release: Schema.optionalKey(Release),
        repo: Schema.optionalKey(RepoName),
      }),
      success: Run,
      error: [JobNotFound, ReleaseRequired, RepoNotScopable],
    }),
    /** Let a parked job be queued again. */
    HttpApiEndpoint.delete("unpark", "/:id/park", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: JobNotFound,
    }),
    /**
     * Turn a job off: nothing queues it until it's resumed, though it can
     * still be run by hand. A run already going carries on.
     */
    HttpApiEndpoint.put("pause", "/:id/pause", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: JobNotFound,
    }),
    /** Turn a paused job back on. */
    HttpApiEndpoint.delete("resume", "/:id/pause", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: JobNotFound,
    }),
  )
  .middleware(AdminAuthorization)
  .prefix("/api/jobs")
  .annotateMerge(
    OpenApi.annotations({
      title: "Jobs",
      description: "The jobs the server runs, and starting them by hand",
    }),
  ) {}

export class RunsGroup extends HttpApiGroup.make("runs")
  .add(
    HttpApiEndpoint.get("list", "/", {
      query: {
        job: Schema.optional(Schema.String),
        state: Schema.optional(RunState),
        limit: Schema.optional(Schema.Int),
      },
      success: Schema.Array(Run),
    }),
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: Schema.String },
      success: Run,
      error: RunNotFound,
    }),
    /** A run's log, from after line `after` when it's given. */
    HttpApiEndpoint.get("log", "/:id/log", {
      params: { id: Schema.String },
      query: { after: Schema.optional(Schema.Int) },
      success: Schema.Array(LogLine),
      error: RunNotFound,
    }),
    /**
     * Cancel a run. A queued run is dropped; a running one is marked
     * cancelled, and its worker stops at its next heartbeat.
     */
    HttpApiEndpoint.post("cancel", "/:id/cancel", {
      params: { id: Schema.String },
      success: Cancelled,
      error: [RunNotFound, RunFinished],
    }),
    /**
     * Run a finished run again: its job for the same release, or for a heal,
     * the same heal. A parked job runs too, as it does when run by hand. The
     * run is dismissed, as it's been dealt with. Returns the new run.
     */
    HttpApiEndpoint.post("retry", "/:id/retry", {
      params: { id: Schema.String },
      success: Run,
      error: [RunNotFound, RunGoing],
    }),
    /**
     * Clear what a run left for a person: the run stops needing attention
     * and its inbox entry is dismissed.
     */
    HttpApiEndpoint.post("dismiss", "/:id/dismiss", {
      params: { id: Schema.String },
      success: Run,
      error: RunNotFound,
    }),
  )
  .middleware(AdminAuthorization)
  .prefix("/api/runs")
  .annotateMerge(
    OpenApi.annotations({
      title: "Runs",
      description: "Each run of a job, newest first, and its log",
    }),
  ) {}

export class ActivityGroup extends HttpApiGroup.make("activity")
  .add(
    /** What happened in the last `hours`, 24 by default. */
    HttpApiEndpoint.get("get", "/", {
      query: { hours: Schema.optional(Schema.FiniteFromString) },
      success: Activity,
    }),
  )
  .middleware(AdminAuthorization)
  .prefix("/api/activity")
  .annotateMerge(
    OpenApi.annotations({
      title: "Activity",
      description:
        "What happened lately: how runs ended, the commits they pushed and what needs a person",
    }),
  ) {}

export class StatusGroup extends HttpApiGroup.make("status")
  .add(
    /**
     * Upkeep's one status: its health, what needs you and the live workers,
     * which the CLI, the bar and the dashboard all read.
     */
    HttpApiEndpoint.get("get", "/", { success: Status }),
  )
  .middleware(AdminAuthorization)
  .prefix("/api/status")
  .annotateMerge(
    OpenApi.annotations({
      title: "Status",
      description: "How Upkeep is as a whole, and what needs you",
    }),
  ) {}

export class InboxGroup extends HttpApiGroup.make("inbox")
  .add(
    /**
     * Every entry that's unread or changed in the last `days`, `inboxDays`
     * by default, newest first.
     */
    HttpApiEndpoint.get("get", "/", {
      query: { days: Schema.optional(Schema.FiniteFromString) },
      success: Inbox,
    }),
    /** Mark entries read, or every unread one without `ids`. */
    HttpApiEndpoint.post("read", "/read", {
      payload: Schema.Struct({
        ids: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
      success: HttpApiSchema.NoContent,
    }),
    /** Take an entry out of the inbox until something new is added to it. */
    HttpApiEndpoint.post("dismiss", "/:id/dismiss", {
      params: { id: Schema.String },
      success: Entry,
      error: EntryNotFound,
    }),
  )
  .middleware(AdminAuthorization)
  .prefix("/api/inbox")
  .annotateMerge(
    OpenApi.annotations({
      title: "Inbox",
      description:
        "What changed in the tracked repositories and what needs a person, grouped by change",
    }),
  ) {}

export class AttentionGroup extends HttpApiGroup.make("attention")
  .add(
    /** Every item, and what changed since you last looked. */
    HttpApiEndpoint.get("get", "/", {
      success: Attention,
    }),
    /**
     * Note that you're looking now. Within half an hour of the last look it
     * counts as the same visit, so Since you last looked keeps its start.
     */
    HttpApiEndpoint.post("looked", "/looked", {
      success: HttpApiSchema.NoContent,
    }),
    /**
     * Queue the attention job when its last run is more than a few minutes
     * old and none is waiting. Returns the run queued, or null.
     */
    HttpApiEndpoint.post("refresh", "/refresh", {
      success: Schema.Struct({ run: Schema.NullOr(Run) }),
    }),
    /**
     * Ask a worker to do something once, such as mark a notification read,
     * by queueing a run of the command job. The same command still waiting
     * is returned instead of a second one. Marking read shows on the page at
     * once: its items lose their unread and mention signals, and an item
     * that's only the notification is hidden.
     */
    HttpApiEndpoint.post("command", "/commands", {
      payload: Command,
      success: Run,
    }),
    /**
     * Hide an item until anything about it changes, or show it again. An
     * item that's gone is left alone.
     */
    HttpApiEndpoint.post("hide", "/hide", {
      payload: Schema.Struct({ url: Schema.String, hidden: Schema.Boolean }),
      success: HttpApiSchema.NoContent,
    }),
    /**
     * Start a group of work, by hand, with the items given moved into it.
     * Focus defaults to watching.
     */
    HttpApiEndpoint.post("createGroup", "/groups", {
      payload: Schema.Struct({
        name: Schema.String,
        focus: Schema.optionalKey(AttentionFocus),
        notes: Schema.optionalKey(Schema.NullOr(Schema.String)),
        items: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
      success: AttentionGroupSchema,
    }),
    /** Rename a group, or change its focus or notes. */
    HttpApiEndpoint.patch("updateGroup", "/groups/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        focus: Schema.optionalKey(AttentionFocus),
        notes: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
      success: HttpApiSchema.NoContent,
      error: GroupNotFound,
    }),
    /**
     * Remove a group, with its waits and comments. Its items go back to
     * their sections.
     */
    HttpApiEndpoint.delete("deleteGroup", "/groups/:id", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: GroupNotFound,
    }),
    /**
     * Move an item into a group, by hand, or out of any with null. This also
     * accepts the agent's suggestion for that group.
     */
    HttpApiEndpoint.put("link", "/links", {
      payload: Schema.Struct({
        url: Schema.String,
        group: Schema.NullOr(Schema.String),
      }),
      success: HttpApiSchema.NoContent,
      error: GroupNotFound,
    }),
    /** Note something outside GitHub a group waits on. */
    HttpApiEndpoint.post("addWait", "/groups/:id/waits", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        text: Schema.String,
        url: Schema.optionalKey(Schema.NullOr(Schema.String)),
        recheckAt: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
      }),
      success: AttentionWait,
      error: GroupNotFound,
    }),
    /** Drop an outside wait, such as once it's happened. */
    HttpApiEndpoint.delete("removeWait", "/waits/:id", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
    }),
    /** Tell the agent something about an item or a group, for its next run. */
    HttpApiEndpoint.post("comment", "/comments", {
      payload: Schema.Union([
        Schema.Struct({ url: Schema.String, text: Schema.String }),
        Schema.Struct({ group: Schema.String, text: Schema.String }),
      ]),
      success: AttentionComment,
      error: GroupNotFound,
    }),
    /** Give the agent a standing instruction. */
    HttpApiEndpoint.post("addRule", "/rules", {
      payload: Schema.Struct({ text: Schema.String }),
      success: AttentionRule,
    }),
    /** Remove a standing instruction. */
    HttpApiEndpoint.delete("removeRule", "/rules/:id", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
    }),
  )
  .middleware(AdminAuthorization)
  .prefix("/api/attention")
  .annotateMerge(
    OpenApi.annotations({
      title: "Attention",
      description:
        "What needs you on GitHub: pull requests, issues and notifications, by section",
    }),
  ) {}

export class WorkGroup extends HttpApiGroup.make("work")
  .add(
    /**
     * Take the oldest waiting run of one of these jobs, if there is one.
     * `agents` is how the worker is set up to heal, which the dashboard shows.
     * A worker sending an older `protocol` than the server's, or none, is
     * refused before any run is taken.
     */
    HttpApiEndpoint.post("claim", "/claim", {
      payload: Schema.Struct({
        jobs: Schema.Array(JobId),
        agents: Schema.optionalKey(AgentSetup),
        protocol: Schema.optionalKey(Schema.Int),
      }),
      success: Schema.Struct({ run: Schema.NullOr(Run) }),
      error: WorkerOutdated,
    }),
    /** Tell the server the run is still going. */
    HttpApiEndpoint.post("heartbeat", "/runs/:id/heartbeat", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: [RunNotFound, RunNotClaimed],
    }),
    HttpApiEndpoint.post("log", "/runs/:id/log", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        lines: Schema.Array(LogEntry).pipe(
          Schema.check(Schema.isMaxLength(maxLogLines)),
        ),
      }),
      success: HttpApiSchema.NoContent,
      error: [RunNotFound, RunNotClaimed],
    }),
    HttpApiEndpoint.post("finish", "/runs/:id/finish", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        outcome: Outcome,
        error: Schema.optionalKey(Schema.String),
        /**
         * The consumers that failed, for a bump. Each gets its own heal;
         * without any, a failure heals Upkeep itself.
         */
        consumers: Schema.optionalKey(Schema.Array(RepoName)),
        /**
         * The worker was stopped mid-run, such as by a restart. The server
         * puts the run back in the queue the first time, rather than failing it.
         */
        interrupted: Schema.optionalKey(Schema.Boolean),
      }),
      success: HttpApiSchema.NoContent,
      error: [RunNotFound, RunNotClaimed],
    }),
    /** Fill in a heal's record as it goes. `action` adds to its actions. */
    HttpApiEndpoint.post("heal", "/runs/:id/heal", {
      params: { id: Schema.String },
      payload: HealUpdate,
      success: HttpApiSchema.NoContent,
      error: [RunNotFound, RunNotClaimed],
    }),
    /**
     * Share the session a heal's agent left, so any worker can open it. One
     * shared before is replaced.
     */
    HttpApiEndpoint.put("shareSession", "/runs/:id/session", {
      params: { id: Schema.String },
      payload: SessionExport,
      success: HttpApiSchema.NoContent,
      error: [RunNotFound, RunNotClaimed],
    }),
    /** A session a worker shared, to import before opening it. */
    HttpApiEndpoint.get("session", "/sessions/:id", {
      params: { id: Schema.String },
      success: SessionExport,
      error: SessionNotFound,
    }),
    /** Report a run's summary, a commit it pushed, or that it needs a person. */
    HttpApiEndpoint.post("report", "/runs/:id/report", {
      params: { id: Schema.String },
      payload: RunReport,
      success: HttpApiSchema.NoContent,
      error: [RunNotFound, RunNotClaimed],
    }),
    /**
     * A heal's record, the run it's healing with the end of its log, and the
     * same or similar failures triage has seen before.
     */
    HttpApiEndpoint.get("healing", "/runs/:id/healing", {
      params: { id: Schema.String },
      success: Schema.Struct({
        heal: Heal,
        run: Run,
        log: Schema.Array(LogLine),
        precedents: Schema.Array(Precedent),
      }),
      error: [RunNotFound, RunNotClaimed],
    }),
    /** The heals queued since `since`, newest first, for the daily limit. */
    HttpApiEndpoint.get("heals", "/heals", {
      query: { since: Schema.FiniteFromString },
      success: Schema.Array(Run),
    }),
    /** The parked jobs, for a worker's own status. */
    HttpApiEndpoint.get("parked", "/parked", {
      success: Schema.Array(Schema.Struct({ job: JobId, ...Parked.fields })),
    }),
    /**
     * Queue the failed job again for a heal, for the same release. Nothing is
     * queued while the job is parked.
     */
    HttpApiEndpoint.post("retry", "/runs/:id/retry", {
      params: { id: Schema.String },
      success: Schema.Struct({ run: Schema.NullOr(Run) }),
      error: [RunNotFound, RunNotClaimed],
    }),
    /**
     * Park a job, so nothing queues it until it's unparked. With its triage
     * issue, resolving that issue unparks it.
     */
    HttpApiEndpoint.post("park", "/park/:job", {
      params: { job: Schema.String },
      payload: Schema.Struct({
        reason: Schema.String,
        issue: Schema.optionalKey(Schema.String),
      }),
      success: HttpApiSchema.NoContent,
      error: JobNotFound,
    }),
    /**
     * The repositories opted into a job, which are all it works on, or every
     * tracked repository without `job`.
     */
    HttpApiEndpoint.get("repos", "/repos", {
      query: { job: Schema.optional(JobId) },
      success: Schema.Array(RepoName),
    }),
    /** Record tracked repositories' titles, which the watch job reads. */
    HttpApiEndpoint.post("titles", "/repos/titles", {
      payload: Schema.Struct({
        titles: Schema.Array(RepoTitle).pipe(
          Schema.check(Schema.isMaxLength(maxCommits)),
        ),
      }),
      success: HttpApiSchema.NoContent,
    }),
    /**
     * Record the names to show tracked repositories by, from a worker's
     * `names` command. A name set by hand is kept.
     */
    HttpApiEndpoint.post("names", "/repos/names", {
      payload: Schema.Struct({
        names: Schema.Array(RepoLabel).pipe(
          Schema.check(Schema.isMaxLength(maxCommits)),
        ),
      }),
      success: HttpApiSchema.NoContent,
    }),
    /**
     * The inbox, as the dashboard reads it: entries unread or changed in the
     * last `inboxDays`, for the summary job to write up.
     */
    HttpApiEndpoint.get("inbox", "/inbox", {
      success: Inbox,
    }),
    /** Which of these commits the inbox already has, for the watch job. */
    HttpApiEndpoint.post("known", "/inbox/known", {
      payload: Schema.Struct({
        commits: Schema.Array(CommitRef).pipe(
          Schema.check(Schema.isMaxLength(maxCommits)),
        ),
      }),
      success: Schema.Struct({ known: Schema.Array(CommitRef) }),
    }),
    /**
     * Commits the watch job found, made outside Upkeep's own runs. One the
     * inbox already has is skipped. `added` is how many were new.
     */
    HttpApiEndpoint.post("seen", "/inbox/seen", {
      payload: Schema.Struct({
        commits: Schema.Array(Change).pipe(
          Schema.check(Schema.isMaxLength(maxCommits)),
        ),
      }),
      success: Schema.Struct({ added: Schema.Int }),
    }),
    /**
     * What the attention job found. The server keeps each item, records what
     * moved on the ones that changed, and drops the ones that went.
     */
    HttpApiEndpoint.post("attention", "/attention", {
      payload: AttentionSnapshot,
      success: Schema.Struct({
        added: Schema.Int,
        changed: Schema.Int,
        gone: Schema.Int,
      }),
    }),
    /** The Attention page as the dashboard reads it, for the context agent. */
    HttpApiEndpoint.get("attentionPage", "/attention", {
      success: Attention,
    }),
    /** What the context agent made of the items and groups it was given. */
    HttpApiEndpoint.post("attentionContext", "/attention/context", {
      payload: AttentionContext,
      success: HttpApiSchema.NoContent,
    }),
    /**
     * The latest release of each repository. The server queues every job
     * that runs on releases for each one that changed, and only records a
     * repository it sees for the first time. `queued` is the runs it added.
     */
    HttpApiEndpoint.post("releases", "/releases", {
      payload: Schema.Struct({
        releases: Schema.Array(Release).pipe(
          Schema.check(Schema.isMaxLength(maxReleases)),
        ),
      }),
      success: Schema.Struct({ queued: Schema.Array(Run) }),
    }),
    /**
     * The held skill changes still open, and those that ended in the last
     * 30 days, newest first.
     */
    HttpApiEndpoint.get("skillChanges", "/skills/changes", {
      success: Schema.Array(SkillChange),
    }),
    HttpApiEndpoint.get("skillChange", "/skills/changes/:id", {
      params: { id: Schema.String },
      success: SkillChange,
      error: SkillChangeNotFound,
    }),
    /**
     * Keep a skill change, as the worker running its agent. One now waiting
     * drops any older one waiting on the same title, so each holds one.
     */
    HttpApiEndpoint.put("putSkillChange", "/skills/changes/:id", {
      params: { id: Schema.String },
      payload: SkillChangeInput,
      success: HttpApiSchema.NoContent,
    }),
    HttpApiEndpoint.post("skillChangeState", "/skills/changes/:id/state", {
      params: { id: Schema.String },
      payload: SkillChangeStateUpdate,
      success: HttpApiSchema.NoContent,
      error: SkillChangeNotFound,
    }),
    /**
     * Queue a `skill-*` command as a run of the skill-change job. The same
     * command still waiting is returned instead of a second one.
     */
    HttpApiEndpoint.post("skillCommand", "/skills/commands", {
      payload: Command,
      success: Run,
    }),
    /** Keep a repository's skills as the worker just read them. */
    HttpApiEndpoint.put("putSkills", "/skills/snapshot", {
      payload: SkillsSnapshot,
      success: HttpApiSchema.NoContent,
    }),
  )
  .middleware(WorkerAuthorization)
  .prefix("/api/work")
  .annotateMerge(
    OpenApi.annotations({
      title: "Work",
      description:
        "Runs for workers to take, their logs and outcomes, and the releases they find",
    }),
  ) {}

export class ReposGroup extends HttpApiGroup.make("repos")
  .add(
    HttpApiEndpoint.get("list", "/", {
      success: Schema.Array(TrackedRepo),
    }),
    /**
     * Track a repository, or change the jobs it's opted into. Without `jobs`
     * it's opted into every job that works on repositories.
     */
    HttpApiEndpoint.put("track", "/:owner/:name", {
      params: { owner: Schema.String, name: Schema.String },
      payload: Schema.Struct({ jobs: Schema.optionalKey(Schema.Array(JobId)) }),
      success: TrackedRepo,
      error: UntrackedJobs,
    }),
    /**
     * Set the name a repository shows by, over its title and any name a
     * worker gives it. Null clears it, so a worker's name or the title shows.
     */
    HttpApiEndpoint.patch("rename", "/:owner/:name", {
      params: { owner: Schema.String, name: Schema.String },
      payload: Schema.Struct({
        name: Schema.NullOr(
          Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
        ),
      }),
      success: TrackedRepo,
      error: RepoNotTracked,
    }),
    /** Stop tracking a repository, so no job works on it. */
    HttpApiEndpoint.delete("untrack", "/:owner/:name", {
      params: { owner: Schema.String, name: Schema.String },
      success: HttpApiSchema.NoContent,
      error: RepoNotTracked,
    }),
  )
  .middleware(AdminAuthorization)
  .prefix("/api/repos")
  .annotateMerge(
    OpenApi.annotations({
      title: "Repositories",
      description:
        "The repositories Upkeep looks after and the jobs each is opted into",
    }),
  ) {}

export class SkillsGroup extends HttpApiGroup.make("skills")
  .add(
    /** Each repository's skills, their held changes, and the workers. */
    HttpApiEndpoint.get("get", "/", {
      success: SkillsPage,
    }),
    /** Land a held change, on any worker. */
    HttpApiEndpoint.post("approve", "/changes/:id/approve", {
      params: { id: Schema.String },
      success: Run,
      error: SkillChangeNotFound,
    }),
    /**
     * Ask for more on a held change. With `here`, its session resumes on the
     * worker it ran on; without, any worker starts again from its patch.
     */
    HttpApiEndpoint.post("revise", "/changes/:id/revise", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        comment: Schema.String.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(4000),
        ),
        here: Schema.Boolean,
      }),
      success: Run,
      error: SkillChangeNotFound,
    }),
    /** Drop a held change. */
    HttpApiEndpoint.post("drop", "/changes/:id/drop", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: SkillChangeNotFound,
    }),
    /** Open an agent on a held change in its checkout, on its worker. */
    HttpApiEndpoint.post("open", "/changes/:id/open", {
      params: { id: Schema.String },
      success: Run,
      error: SkillChangeNotFound,
    }),
    /** Ask an agent for a change to a skill, held for your approval. */
    HttpApiEndpoint.post("request", "/requests", {
      payload: Schema.Struct({
        repo: RepoName,
        skill: Schema.String.check(Schema.isMinLength(1)),
        prompt: Schema.String.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(4000),
        ),
      }),
      success: Run,
    }),
  )
  .middleware(AdminAuthorization)
  .prefix("/api/skills")
  .annotateMerge(
    OpenApi.annotations({
      title: "Skills",
      description:
        "The shared skills, how each stands, and the changes agents made to them, held for approval",
    }),
  ) {}

export class SessionsGroup extends HttpApiGroup.make("sessions")
  .add(
    /** A session a worker shared, for `upkeep open` to import and open. */
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: Schema.String },
      success: SessionExport,
      error: SessionNotFound,
    }),
  )
  .middleware(AdminAuthorization)
  .prefix("/api/sessions")
  .annotateMerge(
    OpenApi.annotations({
      title: "Sessions",
      description: "Agents' OpenCode sessions that workers shared",
    }),
  ) {}

export class TokensGroup extends HttpApiGroup.make("tokens")
  .add(
    HttpApiEndpoint.get("list", "/:scope", {
      params: { scope: TokenScope },
      success: Schema.Array(Token),
    }),
    HttpApiEndpoint.post("add", "/:scope", {
      params: { scope: TokenScope },
      payload: Schema.Struct({ name: TokenName }),
      success: Schema.Struct({
        /** The new token, which is never shown again. */
        token: Schema.String,
      }),
      error: TokenExists,
    }),
    HttpApiEndpoint.delete("remove", "/:scope/:name", {
      params: { scope: TokenScope, name: Schema.String },
      success: HttpApiSchema.NoContent,
      error: TokenNotFound,
    }),
  )
  .middleware(AdminAuthorization)
  .prefix("/api/tokens")
  .annotateMerge(
    OpenApi.annotations({
      title: "Tokens",
      description: "Add, list and revoke the tokens admins and workers use",
    }),
  ) {}

export class SystemGroup extends HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("health", "/api/health", {
    success: HttpApiSchema.NoContent,
  }),
  /** The server's version, which the dashboard shows. */
  HttpApiEndpoint.get("version", "/api/version", {
    success: Schema.Struct({ version: Schema.String }),
  }),
) {}

/** The Upkeep server's HTTP API. */
export class Api extends HttpApi.make("upkeep")
  .add(JobsGroup)
  .add(RunsGroup)
  .add(ActivityGroup)
  .add(StatusGroup)
  .add(InboxGroup)
  .add(AttentionGroup)
  .add(WorkGroup)
  .add(ReposGroup)
  .add(SkillsGroup)
  .add(SessionsGroup)
  .add(TokensGroup)
  .add(SystemGroup)
  .annotateMerge(OpenApi.annotations({ title: "Upkeep" })) {}
