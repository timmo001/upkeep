/**
 * The MCP server: the CLI's operations as tools on stdio, built from the same
 * `Jobs` service and server client so an agent sees what a person does.
 */
import { BunStdio } from "@effect/platform-bun";
import { Api, Client, Domain } from "@upkeep/api";
import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import packageJson from "../package.json" with { type: "json" };
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
  description: "List the jobs upkeep runs",
  success: Schema.Struct({ jobs: Schema.Array(Job) }),
  failure: JobsError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Runs = Tool.make("runs", {
  description:
    "List runs on the server in $UPKEEP_SERVER, newest first, optionally of one job or in one state",
  parameters: Schema.Struct({
    job: Schema.optional(Domain.JobId),
    state: Schema.optional(Domain.RunState),
    limit: Schema.optional(Schema.Int),
  }),
  success: Schema.Struct({ runs: Schema.Array(Domain.Run) }),
  failure: UpkeepError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Log = Tool.make("log", {
  description: `A run's log, from after line \`after\` when it's given, up to ${Api.maxLogLines} lines at a time`,
  parameters: Schema.Struct({
    run: Schema.String,
    after: Schema.optional(Schema.Int),
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
    "Queue a run of a job on the server. A run of the same job and release that's still waiting is returned instead of a second one.",
  parameters: Schema.Struct({
    job: Domain.JobId,
    release: Schema.optional(Domain.Release),
  }),
  success: Domain.Run,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Tools = Toolkit.make(Status, Runs, Log, Run);

/** Call the server as the admin in the environment, failing with a readable error. */
const onServer = <A, E extends { readonly message: string }>(
  effect: Effect.Effect<A, E, Client>,
) =>
  effect.pipe(
    Effect.provide(adminClientFromEnv),
    Effect.mapError((error) => new UpkeepError({ message: error.message })),
  );

const handlers = Effect.gen(function* () {
  const jobs = yield* Jobs;

  return {
    status: () => Effect.map(jobs.list(), (list) => ({ jobs: list })),
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
    }) =>
      onServer(
        Client.use((client) =>
          client.jobs.run({
            params: { id: input.job },
            payload:
              input.release === undefined ? {} : { release: input.release },
          }),
        ),
      ),
  };
});

/** Serve the operations over MCP on stdio until the client disconnects. */
export const serveMcp = Effect.fn("serveMcp")(function* () {
  const implementation = yield* handlers;

  return yield* McpServer.toolkit(Tools).pipe(
    Layer.provide(Tools.toLayer(Effect.succeed(implementation))),
    Layer.provide(
      McpServer.layerStdio({
        name: "upkeep",
        version: packageJson.version,
        protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25],
      }),
    ),
    Layer.provide(BunStdio.layer),
    Layer.launch,
  );
});
