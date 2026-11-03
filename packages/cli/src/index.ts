/** The Upkeep CLI: every command lives in this tree so help and completions come from one place. */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Api, Client } from "@upkeep/api";
import { Server } from "@upkeep/server";
import { Config, Console, Effect, Layer } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import packageJson from "../package.json" with { type: "json" };
import { Jobs } from "./jobs/Jobs";
import { serveMcp } from "./mcp";
import { operations } from "./operations";

const json = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON for scripts and agents instead of text"),
  Flag.withDefault(false),
);

/** The server to talk to, from `--server` or `$UPKEEP_SERVER`. */
const server = Flag.String("server").pipe(
  Flag.withDescription("The Upkeep server's URL, or $UPKEEP_SERVER"),
  Flag.withFallbackConfig(Config.String("UPKEEP_SERVER")),
);

/** A client for the server, as the admin in `$UPKEEP_ADMIN_TOKEN`. */
const adminClient = (url: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const token = yield* Config.Redacted("UPKEEP_ADMIN_TOKEN");

      return Client.layer({ url, token });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));

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

const serve = Command.make(
  "serve",
  {
    hostname: Flag.String("hostname").pipe(
      Flag.withDescription("The address to listen on"),
      Flag.withFallbackConfig(Config.String("UPKEEP_HOSTNAME")),
      Flag.withDefault("127.0.0.1"),
    ),
    port: Flag.Int("port").pipe(
      Flag.withAlias("p"),
      Flag.withDescription("The port to listen on"),
      Flag.withFallbackConfig(Config.Int("UPKEEP_PORT")),
      Flag.withDefault(7272),
    ),
  },
  (options) => Layer.launch(Server.layer(options)),
).pipe(
  Command.withDescription(
    "Run the server: the API, the job schedule and the store in $UPKEEP_SERVER_DB",
  ),
);

const tokenCommands = (options: {
  readonly scope: Api.TokenScope;
  readonly command: string;
  readonly description: string;
  readonly noun: string;
  readonly nameDescription: string;
  readonly variable: string;
}) => {
  const name = Argument.String("name").pipe(
    Argument.withDescription(options.nameDescription),
    Argument.withSchema(Api.TokenName),
  );

  const add = Command.make(
    "add",
    { name, server },
    Effect.fn(
      function* (input) {
        const client = yield* Client;

        const { token } = yield* client.tokens.add({
          params: { scope: options.scope },
          payload: { name: input.name },
        });

        yield* Console.log(
          `Added ${input.name}. Set this as ${options.variable}; it won't be shown again:\n${token}`,
        );
      },
      (effect, input) => Effect.provide(effect, adminClient(input.server)),
    ),
  ).pipe(Command.withDescription(`Add ${options.noun} and print its token`));

  const list = Command.make(
    "list",
    { json, server },
    Effect.fn(
      function* (input) {
        const client = yield* Client;

        const all = yield* client.tokens.list({
          params: { scope: options.scope },
        });

        if (input.json) return yield* Console.log(JSON.stringify(all, null, 2));

        if (all.length === 0) {
          return yield* Console.log(
            `No ${options.command} yet. Add one with upkeep ${options.command} add <name>.`,
          );
        }

        for (const token of all) {
          yield* Console.log(
            `${token.name}  ${new Date(token.createdAt).toISOString()}`,
          );
        }
      },
      (effect, input) => Effect.provide(effect, adminClient(input.server)),
    ),
  ).pipe(Command.withDescription(`List the ${options.command}, oldest first`));

  const remove = Command.make(
    "remove",
    { name, server },
    Effect.fn(
      function* (input) {
        const client = yield* Client;

        yield* client.tokens.remove({
          params: { scope: options.scope, name: input.name },
        });

        yield* Console.log(`Removed ${input.name}; its token no longer works`);
      },
      (effect, input) => Effect.provide(effect, adminClient(input.server)),
    ),
  ).pipe(Command.withDescription(`Remove ${options.noun}, revoking its token`));

  return Command.make(options.command).pipe(
    Command.withDescription(options.description),
    Command.withSubcommands([add, list, remove]),
  );
};

const admins = tokenCommands({
  scope: "admin",
  command: "admins",
  description:
    "Manage the admins that can read runs, start jobs and manage tokens",
  noun: "an admin",
  nameDescription: "A name for the admin, such as aidan",
  variable: "UPKEEP_ADMIN_TOKEN wherever you run upkeep",
});

const workers = tokenCommands({
  scope: "worker",
  command: "workers",
  description: "Manage the workers that can take and run jobs",
  noun: "a worker",
  nameDescription:
    "A name for the worker that doesn't identify the machine, such as desktop",
  variable: "UPKEEP_WORKER_TOKEN on the worker",
});

const upkeep = Command.make("upkeep").pipe(
  Command.withDescription("Keep repositories and their consumers up to date"),
  Command.withSubcommands([status, serve, admins, workers, agent, mcp]),
);

upkeep.pipe(
  Command.run({ version: packageJson.version }),
  Effect.provide(Layer.mergeAll(Jobs.catalogue, BunServices.layer)),
  BunRuntime.runMain,
);
