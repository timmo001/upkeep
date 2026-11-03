/**
 * The MCP server: the CLI's operations as tools on stdio, built from the same
 * `Jobs` service so an agent sees what a person does.
 */
import { BunStdio } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import packageJson from "../package.json" with { type: "json" };
import { Job, Jobs, JobsError } from "./jobs/Jobs";

// Failures go back to the client as the tool's result, so an agent can read
// them and carry on.
const Status = Tool.make("status", {
  description: "List the jobs upkeep runs",
  success: Schema.Struct({ jobs: Schema.Array(Job) }),
  failure: JobsError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Tools = Toolkit.make(Status);

const handlers = Effect.gen(function* () {
  const jobs = yield* Jobs;

  return {
    status: () => Effect.map(jobs.list(), (list) => ({ jobs: list })),
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
