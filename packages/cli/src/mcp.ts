/**
 * The MCP server: the CLI's operations as tools on stdio, built from the same
 * `Jobs` service and server client so an agent sees what a person does.
 */
import { BunStdio } from "@effect/platform-bun";
import { Api, Client, Domain } from "@upkeep/api";
import { version } from "@upkeep/server";
import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { adminClientFromEnv } from "./clients";
import { Job, Jobs, JobsError } from "./jobs/Jobs";

/** Why a tool that talks to the server failed. */
export class UpkeepError extends Schema.TaggedError<UpkeepError>()(
  "UpkeepError",
  { message: Schema.String },
) {}

// Failures go back to the client as the tool's result, so an agent can read
// them and carry on.
const Status = Tool.make("status", {
  description:
    "Upkeep's one status from the server in $UPKEEP_SERVER: its health, what needs you with the dashboard page for each, the parked jobs and the live workers",
  success: Domain.Status,
  failure: UpkeepError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const JobsTool = Tool.make("jobs", {
  description: "List the jobs upkeep runs",
  success: Schema.Struct({ jobs: Schema.Array(Job) }),
  failure: JobsError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Runs = Tool.make("runs", {
  description:
    "List runs on the server in $UPKEEP_SERVER, newest first, optionally of one job or in one state",
  parameters: Schema.Struct({
    job: Schema.optionalKey(Domain.JobId),
    state: Schema.optionalKey(Domain.RunState),
    limit: Schema.optionalKey(Schema.Int),
  }),
  success: Schema.Struct({ runs: Schema.Array(Domain.Run) }),
  failure: UpkeepError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Log = Tool.make("log", {
  description: `A run's log, from after line \`after\` when it's given, up to ${Api.maxLogLines} lines at a time`,
  parameters: Schema.Struct({
    run: Schema.String,
    after: Schema.optionalKey(Schema.Int),
  }),
  success: Schema.Struct({
    run: Domain.Run,
    lines: Schema.Array(Domain.LogLine),
  }),
  failure: UpkeepError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Run = Tool.make("run", {
  description:
    "Queue a run of a job on the server. A run of the same job and release that's still waiting is returned instead of a second one. Give repo to work on only that tracked repository; a waiting run for it or for every repository is returned instead.",
  parameters: Schema.Struct({
    job: Domain.JobId,
    release: Schema.optionalKey(Domain.Release),
    repo: Schema.optionalKey(Domain.RepoName),
  }),
  success: Domain.Run,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Cancel = Tool.make("cancel", {
  description:
    "Cancel a run on the server. A queued run is dropped; a running one is marked cancelled and its worker stops it shortly.",
  parameters: Schema.Struct({ run: Schema.String }),
  success: Api.Cancelled,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

const Retry = Tool.make("retry", {
  description:
    "Run a finished run again: its job for the same release, or for a heal, the same heal, even when the job is parked. The old run is dismissed. Returns the new run.",
  parameters: Schema.Struct({ run: Schema.String }),
  success: Domain.Run,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

const Dismiss = Tool.make("dismiss", {
  description:
    "Clear what a run left for a person: it stops needing attention and its inbox entry is dismissed",
  parameters: Schema.Struct({ run: Schema.String }),
  success: Domain.Run,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Unpark = Tool.make("unpark", {
  description:
    "Let a parked job be queued again by its schedule, releases and heals",
  parameters: Schema.Struct({ job: Domain.JobId }),
  success: Schema.Struct({ job: Domain.JobId }),
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Pause = Tool.make("pause", {
  description:
    "Turn a job off without stopping the server or worker: nothing queues it by schedule, release or heal until it's resumed, though it can still be run by hand. Pause heal to stop every heal.",
  parameters: Schema.Struct({ job: Domain.JobId }),
  success: Schema.Struct({ job: Domain.JobId }),
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Resume = Tool.make("resume", {
  description: "Turn a paused job back on",
  parameters: Schema.Struct({ job: Domain.JobId }),
  success: Schema.Struct({ job: Domain.JobId }),
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Repos = Tool.make("repos", {
  description:
    "List the repositories the server tracks and the jobs each is opted into. A job that works on repositories leaves every other one alone.",
  success: Schema.Struct({ repos: Schema.Array(Domain.TrackedRepo) }),
  failure: UpkeepError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Track = Tool.make("track", {
  description:
    "Track a repository, or change the jobs it's opted into. Without jobs it's opted into every job that works on repositories.",
  parameters: Schema.Struct({
    repo: Domain.RepoName,
    jobs: Schema.optionalKey(Schema.Array(Domain.JobId)),
  }),
  success: Domain.TrackedRepo,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Rename = Tool.make("rename", {
  description:
    "Set the name a repository shows by in the dashboard, over its README title and any name a worker gives it. Leave name out to clear it.",
  parameters: Schema.Struct({
    repo: Domain.RepoName,
    name: Schema.optionalKey(Schema.String),
  }),
  success: Domain.TrackedRepo,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Untrack = Tool.make("untrack", {
  description: "Stop tracking a repository, so no job works on it",
  parameters: Schema.Struct({ repo: Domain.RepoName }),
  success: Schema.Struct({ repo: Domain.RepoName }),
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

const Activity = Tool.make("activity", {
  description:
    "What happened lately on the server: how runs ended, the commits they pushed, newest first, and the runs that need a person. `hours` defaults to 24.",
  parameters: Schema.Struct({ hours: Schema.optionalKey(Schema.Finite) }),
  success: Domain.Activity,
  failure: UpkeepError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

/** Every operation an agent can call, shared by MCP and Code Mode. */
export const Tools = Toolkit.make(
  Status,
  JobsTool,
  Runs,
  Activity,
  Log,
  Run,
  Cancel,
  Retry,
  Dismiss,
  Unpark,
  Pause,
  Resume,
  Repos,
  Track,
  Rename,
  Untrack,
);

/** A repository's path parameters from `owner/name`. */
const repoParams = (repo: string) => {
  const [owner = "", name = ""] = repo.split("/");

  return { owner, name };
};

/** Call the server as the admin in the environment, failing with a readable error. */
const onServer = <A, E extends { readonly message: string }>(
  effect: Effect.Effect<A, E, Client>,
) =>
  effect.pipe(
    Effect.provide(adminClientFromEnv),
    Effect.mapError((error) => new UpkeepError({ message: error.message })),
  );

/** The handlers behind `Tools`. */
export const toolsLayer = Tools.toLayer(
  Effect.gen(function* () {
    const jobs = yield* Jobs;

    return {
      status: () => onServer(Client.use((client) => client.status.get())),
      jobs: () => Effect.map(jobs.list(), (list) => ({ jobs: list })),
      runs: (query: {
        readonly job?: string | undefined;
        readonly state?: Domain.RunState | undefined;
        readonly limit?: number | undefined;
      }) =>
        onServer(
          Client.use((client) =>
            client.runs.list({ query }).pipe(Effect.map((runs) => ({ runs }))),
          ),
        ),
      activity: (input: { readonly hours?: number | undefined }) =>
        onServer(
          Client.use((client) =>
            client.activity.get({ query: { hours: input.hours } }),
          ),
        ),
      log: (input: {
        readonly run: string;
        readonly after?: number | undefined;
      }) =>
        onServer(
          Effect.gen(function* () {
            const client = yield* Client;
            const params = { id: input.run };

            return {
              run: yield* client.runs.get({ params }),
              lines: yield* client.runs.log({
                params,
                query: { after: input.after },
              }),
            };
          }),
        ),
      run: (input: {
        readonly job: string;
        readonly release?: Domain.Release | undefined;
        readonly repo?: string | undefined;
      }) =>
        onServer(
          Client.use((client) =>
            client.jobs.run({
              params: { id: input.job },
              payload: {
                ...(input.release !== undefined && { release: input.release }),
                ...(input.repo !== undefined && { repo: input.repo }),
              },
            }),
          ),
        ),
      cancel: (input: { readonly run: string }) =>
        onServer(
          Client.use((client) =>
            client.runs.cancel({ params: { id: input.run } }),
          ),
        ),
      retry: (input: { readonly run: string }) =>
        onServer(
          Client.use((client) =>
            client.runs.retry({ params: { id: input.run } }),
          ),
        ),
      dismiss: (input: { readonly run: string }) =>
        onServer(
          Client.use((client) =>
            client.runs.dismiss({ params: { id: input.run } }),
          ),
        ),
      unpark: (input: { readonly job: string }) =>
        onServer(
          Client.use((client) =>
            client.jobs
              .unpark({ params: { id: input.job } })
              .pipe(Effect.as({ job: input.job })),
          ),
        ),
      pause: (input: { readonly job: string }) =>
        onServer(
          Client.use((client) =>
            client.jobs
              .pause({ params: { id: input.job } })
              .pipe(Effect.as({ job: input.job })),
          ),
        ),
      resume: (input: { readonly job: string }) =>
        onServer(
          Client.use((client) =>
            client.jobs
              .resume({ params: { id: input.job } })
              .pipe(Effect.as({ job: input.job })),
          ),
        ),
      repos: () =>
        onServer(
          Client.use((client) =>
            client.repos.list().pipe(Effect.map((repos) => ({ repos }))),
          ),
        ),
      track: (input: {
        readonly repo: string;
        readonly jobs?: ReadonlyArray<string> | undefined;
      }) =>
        onServer(
          Client.use((client) =>
            client.repos.track({
              params: repoParams(input.repo),
              payload: input.jobs === undefined ? {} : { jobs: input.jobs },
            }),
          ),
        ),
      rename: (input: {
        readonly repo: string;
        readonly name?: string | undefined;
      }) => {
        const typed = input.name?.trim() ?? "";

        return onServer(
          Client.use((client) =>
            client.repos.rename({
              params: repoParams(input.repo),
              payload: { name: typed === "" ? null : typed },
            }),
          ),
        );
      },
      untrack: (input: { readonly repo: string }) =>
        onServer(
          Client.use((client) =>
            client.repos
              .untrack({ params: repoParams(input.repo) })
              .pipe(Effect.as({ repo: input.repo })),
          ),
        ),
    };
  }),
);

/** Serve the operations over MCP on stdio until the client disconnects. */
export const serveMcp = () =>
  McpServer.toolkit(Tools).pipe(
    Layer.provide(toolsLayer),
    Layer.provide(
      McpServer.layerStdio({
        name: "upkeep",
        version,
        protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25],
      }),
    ),
    Layer.provide(BunStdio.layer),
    Layer.launch,
    Effect.withSpan("serveMcp"),
  );
