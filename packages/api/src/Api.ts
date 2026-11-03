/**
 * The server's HTTP API, shared by the server, its workers and the CLI so each
 * side encodes and decodes the same shapes. Admins read jobs and runs, start
 * runs and manage tokens; workers take runs and report on them.
 */
import { Context, Schema } from "effect";
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
  Heal,
  HealDecision,
  JobId,
  JobStatus,
  LogEntry,
  LogLine,
  Outcome,
  Precedent,
  Release,
  RepoName,
  Run,
  RunState,
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

export class RunNotFound extends Schema.TaggedError<RunNotFound>()(
  "RunNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message() {
    return `There's no run ${this.id}`;
  }
}

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
  model: Schema.optionalKey(Schema.String),
  variant: Schema.optionalKey(Schema.String),
  /** Added to the heal's actions. */
  action: Schema.optionalKey(Schema.String),
  commit: Schema.optionalKey(Schema.String),
  session: Schema.optionalKey(Schema.String),
});

export interface HealUpdate extends Schema.Schema.Type<typeof HealUpdate> {}

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

export class JobsGroup extends HttpApiGroup.make("jobs")
  .add(
    HttpApiEndpoint.get("list", "/", {
      success: Schema.Array(JobStatus),
    }),
    /**
     * Queue a run, as the run button does. A run of the job for the same
     * release that's still waiting is returned instead of a second one.
     */
    HttpApiEndpoint.post("run", "/:id/runs", {
      params: { id: Schema.String },
      payload: Schema.Struct({ release: Schema.optionalKey(Release) }),
      success: Run,
      error: JobNotFound,
    }),
    /** Let a parked job be queued again. */
    HttpApiEndpoint.delete("unpark", "/:id/park", {
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
  )
  .middleware(AdminAuthorization)
  .prefix("/api/runs")
  .annotateMerge(
    OpenApi.annotations({
      title: "Runs",
      description: "Each run of a job, newest first, and its log",
    }),
  ) {}

export class WorkGroup extends HttpApiGroup.make("work")
  .add(
    /** Take the oldest waiting run of one of these jobs, if there is one. */
    HttpApiEndpoint.post("claim", "/claim", {
      payload: Schema.Struct({ jobs: Schema.Array(JobId) }),
      success: Schema.Struct({ run: Schema.NullOr(Run) }),
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
    /** The heals queued since `since`, newest first, for the daily digest. */
    HttpApiEndpoint.get("heals", "/heals", {
      query: { since: Schema.FiniteFromString },
      success: Schema.Array(Run),
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
) {}

/** The Upkeep server's HTTP API. */
export class Api extends HttpApi.make("upkeep")
  .add(JobsGroup)
  .add(RunsGroup)
  .add(WorkGroup)
  .add(TokensGroup)
  .add(SystemGroup)
  .annotateMerge(OpenApi.annotations({ title: "Upkeep" })) {}
