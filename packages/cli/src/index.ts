/** The Upkeep CLI: every command lives in this tree so help and completions come from one place. */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer } from "effect";
import { Command, Flag } from "effect/cli";
import packageJson from "../package.json" with { type: "json" };
import { Jobs } from "./jobs/Jobs";
import { serveMcp } from "./mcp";
import { operations } from "./operations";

const json = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON for scripts and agents instead of text"),
  Flag.withDefault(false),
);

const status = Command.make(
  "status",
  { json },
  Effect.fn("status")(function* ({ json }) {
    const jobs = yield* (yield* Jobs).list();

    if (json) return yield* Console.log(JSON.stringify({ jobs }, null, 2));

    if (jobs.length === 0) return yield* Console.log("No jobs yet");

    for (const job of jobs) {
      yield* Console.log(`${job.name}  ${job.description}`);
    }
  }),
).pipe(Command.withDescription("List the jobs upkeep runs"));

/** The Code Mode manifest: every operation with how an agent may use it. */
const agentTools = Command.make(
  "tools",
  { json },
  Effect.fn("agentTools")(function* () {
    const manifest = {
      tool: "upkeep",
      operations: operations.map((operation) => ({
        name: operation.name,
        description: operation.description,
        access: operation.access,
        command: ["upkeep", operation.name],
        json: true,
      })),
    };

    yield* Console.log(JSON.stringify(manifest, null, 2));
  }),
).pipe(Command.withDescription("Print the Code Mode manifest as JSON"));

const agent = Command.make("agent").pipe(
  Command.withDescription("Agent surfaces"),
  Command.withSubcommands([agentTools]),
);

const mcp = Command.make("mcp", {}, () => serveMcp()).pipe(
  Command.withDescription("Serve the operations over MCP on stdio"),
);

const upkeep = Command.make("upkeep").pipe(
  Command.withDescription("Keep repositories and their consumers up to date"),
  Command.withSubcommands([status, agent, mcp]),
);

upkeep.pipe(
  Command.run({ version: packageJson.version }),
  Effect.provide(Layer.mergeAll(Jobs.empty, BunServices.layer)),
  BunRuntime.runMain,
);
