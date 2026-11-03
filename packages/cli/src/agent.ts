/**
 * The Code Mode surface. `upkeep agent tools --json` describes each MCP tool
 * in the shape `dot agent tools --json` prints, and `upkeep agent call <tool>`
 * runs one with its input as JSON on stdin, so Code Mode and MCP share one
 * implementation and the OpenCode plugin only needs the binary.
 */
import {
  Console,
  Duration,
  Effect,
  Option,
  Schema,
  Stdio,
  Stream,
} from "effect";
import { Tool } from "effect/ai";
import { Tools, toolsLayer } from "./mcp";
import { accessOf, type ToolName, toolNames } from "./operations";

/** Why a Code Mode call failed; its message is the tool's JSON failure. */
export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  message: Schema.String,
}) {}

const timeout = Duration.minutes(2);

/** One operation as a Code Mode tool. */
export const ManifestTool = Schema.Struct({
  name: Schema.String,
  argv: Schema.Array(Schema.String),
  description: Schema.String,
  access: Schema.Literals(["read", "write"]),
  alwaysAsk: Schema.Boolean,
  pinned: Schema.Boolean,
  timeoutMillis: Schema.Int,
  json: Schema.Boolean,
  /** The whole input goes to the command as JSON on stdin, so it takes no params. */
  stdin: Schema.Boolean,
  input: Schema.Unknown,
  params: Schema.Array(Schema.Unknown),
});

/** Every operation as a Code Mode tool. */
export const Manifest = Schema.Struct({ tools: Schema.Array(ManifestTool) });

// Effect's AI transformer makes optional keys nullable for model providers;
// Code Mode shows the plain schema, rejecting keys a tool doesn't take.
const jsonSchema = (schema: Schema.Top) => {
  const document = Schema.toJsonSchemaDocument(schema, {
    onExcessProperty: "error",
  });

  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions };
};

export const manifest = (): typeof Manifest.Type => ({
  tools: toolNames.map((name) => {
    const tool = Tools.tools[name];
    const level = accessOf(name);

    return {
      name,
      argv: ["agent", "call", name],
      description: Tool.getDescription(tool) ?? name,
      access: level === "read" ? "read" : "write",
      alwaysAsk: level === "ask" || level === "power",
      pinned: false,
      timeoutMillis: Duration.toMillis(timeout),
      json: true,
      stdin: true,
      input: jsonSchema(tool.parametersSchema),
      params: [],
    };
  }),
});

const readInput = (name: ToolName) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;

    const text = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString);

    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.toEncoded(Tools.tools[name].parametersSchema),
      ),
    )(text.trim() === "" ? "{}" : text, { onExcessProperty: "error" });
  }).pipe(
    Effect.mapError(
      (error) => new AgentError({ message: `Invalid input: ${error.message}` }),
    ),
  );

/** Run one tool with the JSON input on stdin and print its JSON result. */
export const call = Effect.fn("agentCall")(
  function* (name: ToolName) {
    const toolkit = yield* Tools;
    const input = yield* readInput(name);

    const results = yield* toolkit.handle(name, input);
    const last = yield* Stream.runLast(results);

    if (Option.isNone(last)) {
      return yield* new AgentError({ message: `${name} returned nothing` });
    }

    const output = JSON.stringify(last.value.encodedResult, null, 2);

    if (last.value.isFailure) return yield* new AgentError({ message: output });

    yield* Console.log(output);
  },
  Effect.mapError((error) =>
    error instanceof AgentError
      ? error
      : new AgentError({ message: error.message }),
  ),
  Effect.provide(toolsLayer),
);
