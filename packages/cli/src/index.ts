/** The Upkeep CLI: every command lives in this tree so help and completions come from one place. */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Api, Client, Domain } from "@upkeep/api";
import { Server } from "@upkeep/server";
import { ghLayer, handlers, Worker } from "@upkeep/worker";
import {
  Cause,
  Config,
  Console,
  Effect,
  Exit,
  Layer,
  Option,
  Runtime,
  Schema,
} from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import packageJson from "../package.json" with { type: "json" };
import { call, manifest } from "./agent";
import { adminClient, workerClient } from "./clients";
import { Jobs } from "./jobs/Jobs";
import { serveMcp } from "./mcp";
import { toolNames } from "./operations";
import { layerOptions } from "./options";

const json = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON for scripts and agents instead of text"),
  Flag.withDefault(false),
);

/** The server to talk to, from `--server` or `$UPKEEP_SERVER`. */
const server = Flag.String("server").pipe(
  Flag.withDescription("The Upkeep server's URL, or $UPKEEP_SERVER"),
  Flag.withFallbackConfig(Config.String("UPKEEP_SERVER")),
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
    yield* Console.log(JSON.stringify(manifest(), null, 2));
  }),
).pipe(Command.withDescription("Print the Code Mode manifest as JSON"));

const agentCall = Command.make(
  "call",
  {
    tool: Argument.Literals("tool", toolNames).pipe(
      Argument.withDescription("The tool to run, from upkeep agent tools"),
    ),
  },
  ({ tool }) => call(tool),
).pipe(
  Command.withDescription(
    "Run a Code Mode tool with its input as JSON on stdin and print its result",
  ),
);

const agent = Command.make("agent").pipe(
  Command.withDescription("Agent surfaces"),
  Command.withSubcommands([agentTools, agentCall]),
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
    ingressPort: Flag.Int("ingress-port").pipe(
      Flag.withDescription(
        "A second port for Home Assistant ingress, which only answers --ingress-from and needs no admin token",
      ),
      Flag.withFallbackConfig(Config.Int("UPKEEP_INGRESS_PORT")),
      Flag.optional,
    ),
    ingressFrom: Flag.String("ingress-from").pipe(
      Flag.withDescription(
        "The only address the ingress port answers, Home Assistant's Supervisor",
      ),
      Flag.withFallbackConfig(Config.String("UPKEEP_INGRESS_FROM")),
      Flag.withDefault("172.30.32.2"),
    ),
  },
  (options) => Layer.launch(Server.layer(options)),
).pipe(
  Command.withDescription(
    "Run the server: the API, the dashboard, the job schedule and the store in $UPKEEP_SERVER_DB",
  ),
);

export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
}) {}

const time = (at: number | null) =>
  at === null ? "-" : new Date(at).toISOString();

const runLine = (run: Domain.Run) =>
  [
    run.id,
    run.job,
    run.state,
    time(run.queuedAt),
    run.worker ?? "-",
    run.release === null ? "" : `${run.release.repo}@${run.release.tag}`,
    run.heal === null
      ? ""
      : `heals ${run.heal.job} ${run.heal.of} (${run.heal.target.kind === "upkeep" ? "upkeep" : run.heal.target.repo})${run.heal.decision === null ? "" : `: ${run.heal.decision}`}`,
  ]
    .join("  ")
    .trimEnd();

const worker = Command.make("worker", { server }, (input) =>
  Worker.work(handlers).pipe(Effect.provide(workerClient(input.server))),
).pipe(
  Command.withDescription(
    "Take and run jobs from the server with the token in $UPKEEP_WORKER_TOKEN",
  ),
);

/** A release given as `owner/name@tag`. */
const release = Flag.String("release").pipe(
  Flag.withDescription("The release to run it for, as owner/name@tag"),
  Flag.mapEffect((value) => {
    const at = value.lastIndexOf("@");

    return Schema.decodeUnknownEffect(Domain.Release)({
      repo: value.slice(0, at),
      tag: value.slice(at + 1),
      url: `https://github.com/${value.slice(0, at)}/releases/tag/${value.slice(at + 1)}`,
    }).pipe(
      Effect.mapError(
        () =>
          new CliError.InvalidValue({
            option: "release",
            value,
            expected: "an owner/name@tag release",
            kind: "flag",
          }),
      ),
    );
  }),
  Flag.optional,
);

const run = Command.make(
  "run",
  {
    job: Argument.String("job").pipe(
      Argument.withDescription("The job's ID, such as releases"),
    ),
    release,
    local: Flag.Boolean("local").pipe(
      Flag.withDescription(
        "Run it here and print its log, instead of queueing it on the server",
      ),
      Flag.withDefault(false),
    ),
    server: Flag.optional(server),
    json,
  },
  Effect.fn("run")(function* (input) {
    if (input.local) {
      const handler = Option.fromNullishOr(handlers[input.job]);

      if (Option.isNone(handler)) {
        return yield* new UsageError({
          message: `There's no job ${input.job} to run here`,
        });
      }

      return yield* Worker.runLocal(
        handler.value,
        Option.getOrNull(input.release),
      );
    }

    if (Option.isNone(input.server)) {
      return yield* new UsageError({
        message: "Give --server or set $UPKEEP_SERVER, or run it with --local",
      });
    }

    const queued = yield* Effect.gen(function* () {
      const client = yield* Client;

      return yield* client.jobs.run({
        params: { id: input.job },
        payload: Option.match(input.release, {
          onNone: () => ({}),
          onSome: (value) => ({ release: value }),
        }),
      });
    }).pipe(Effect.provide(adminClient(input.server.value)));

    if (input.json) return yield* Console.log(JSON.stringify(queued, null, 2));

    yield* Console.log(
      `Queued ${queued.job} as ${queued.id}. Follow it with upkeep log ${queued.id} --follow.`,
    );
  }),
).pipe(Command.withDescription("Queue a run of a job, or run it here"));

const runs = Command.make(
  "runs",
  {
    job: Flag.String("job").pipe(
      Flag.withDescription("Only this job's runs"),
      Flag.optional,
    ),
    state: Flag.Literals("state", Domain.RunState.literals).pipe(
      Flag.withDescription("Only runs in this state"),
      Flag.optional,
    ),
    limit: Flag.Int("limit").pipe(
      Flag.withDescription(`How many, up to ${Api.maxRuns}`),
      Flag.withDefault(20),
    ),
    server,
    json,
  },
  Effect.fn(
    function* (input) {
      const client = yield* Client;

      const all = yield* client.runs.list({
        query: {
          job: Option.getOrUndefined(input.job),
          state: Option.getOrUndefined(input.state),
          limit: input.limit,
        },
      });

      if (input.json) return yield* Console.log(JSON.stringify(all, null, 2));

      if (all.length === 0) return yield* Console.log("No runs yet");

      for (const each of all) yield* Console.log(runLine(each));
    },
    (effect, input) => Effect.provide(effect, adminClient(input.server)),
  ),
).pipe(Command.withDescription("List runs, newest first"));

const log = Command.make(
  "log",
  {
    run: Argument.String("run").pipe(Argument.withDescription("The run's ID")),
    follow: Flag.Boolean("follow").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("Keep printing new lines until the run ends"),
      Flag.withDefault(false),
    ),
    server,
    json,
  },
  Effect.fn(
    function* (input) {
      const client = yield* Client;
      const params = { id: input.run };
      let after = 0;

      while (true) {
        const finished = input.follow
          ? (yield* client.runs.get({ params })).finishedAt !== null
          : true;

        const lines = yield* client.runs.log({ params, query: { after } });

        for (const line of lines) {
          yield* Console.log(
            input.json
              ? JSON.stringify(line)
              : `${time(line.at)}  ${line.level === "info" ? "" : `${line.level}: `}${line.message}`,
          );

          after = line.seq;
        }

        if (lines.length > 0) continue;

        if (finished) return;

        yield* Effect.sleep("2 seconds");
      }
    },
    (effect, input) => Effect.provide(effect, adminClient(input.server)),
  ),
).pipe(Command.withDescription("Print a run's log, as JSON lines with --json"));

const cancel = Command.make(
  "cancel",
  {
    run: Argument.String("run").pipe(Argument.withDescription("The run's ID")),
    server,
    json,
  },
  Effect.fn(
    function* (input) {
      const client = yield* Client;

      const cancelled = yield* client.runs.cancel({
        params: { id: input.run },
      });

      if (input.json) {
        return yield* Console.log(JSON.stringify(cancelled, null, 2));
      }

      yield* Console.log(
        cancelled.dropped
          ? `Dropped ${cancelled.run.job} from the queue`
          : `Cancelled ${cancelled.run.job}; ${cancelled.run.worker ?? "its worker"} stops at its next heartbeat`,
      );
    },
    (effect, input) => Effect.provide(effect, adminClient(input.server)),
  ),
).pipe(
  Command.withDescription(
    "Cancel a run: drop it from the queue, or stop it on its worker",
  ),
);

const unpark = Command.make(
  "unpark",
  {
    job: Argument.String("job").pipe(Argument.withDescription("The job's ID")),
    server,
  },
  Effect.fn(
    function* (input) {
      const client = yield* Client;

      yield* client.jobs.unpark({ params: { id: input.job } });
      yield* Console.log(`Unparked ${input.job}; it's queued as usual again`);
    },
    (effect, input) => Effect.provide(effect, adminClient(input.server)),
  ),
).pipe(
  Command.withDescription(
    "Unpark a job the server stopped queueing after too many heals",
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
  Command.withSubcommands([
    status,
    run,
    runs,
    log,
    cancel,
    unpark,
    serve,
    worker,
    admins,
    workers,
    agent,
    mcp,
  ]),
);

// SIGTERM is a request to stop, as from Docker or the Home Assistant
// Supervisor, so stopping because of it exits with 0. Ctrl-C still exits
// with 130.
let terminated = false;

process.once("SIGTERM", () => {
  terminated = true;
});

upkeep.pipe(
  Command.run({ version: packageJson.version }),
  Effect.provide(
    Layer.mergeAll(
      Jobs.catalogue,
      ghLayer(),
      FetchHttpClient.layer,
      layerOptions,
    ).pipe(Layer.provideMerge(BunServices.layer)),
  ),
  BunRuntime.runMain({
    teardown: (exit, onExit) =>
      terminated && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        ? onExit(0)
        : Runtime.defaultTeardown(exit, onExit),
  }),
);
