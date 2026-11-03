/**
 * The upkeep OpenCode plugin: upkeep's operations as the `upkeep` Code Mode
 * namespace. It reads them from `upkeep agent tools --json` and runs each with
 * `upkeep agent call`, so the tools always match the binary on the PATH.
 * Modelled on the dotfiles cli-tools plugin.
 */
import { Plugin } from "@opencode/plugin/effect";
import { Tool } from "@opencode/schema/tool";
import { Effect, Result, Schema } from "effect";
import { strictInput } from "./input";
import { loadManifest, type ManifestTool, runUpkeep } from "./upkeep";

const namespace = "upkeep";

const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown),
);

/** Tool input as JSON; each tool's own schema has already checked it. */
const Input = Schema.Record(Schema.String, Schema.Json);

const decodeInput = Schema.decodeUnknownEffect(Input);

export default Plugin.define({
  id: "upkeep",
  effect: (context) =>
    Effect.gen(function* () {
      if (Bun.which("upkeep") === null) return;

      const manifest = yield* loadManifest.pipe(Effect.result);

      if (Result.isFailure(manifest)) {
        return yield* Effect.logWarning(
          `upkeep: no Code Mode tools: ${manifest.failure.message}`,
        );
      }

      const sessionDirectory = (call: Tool.Context) =>
        context.session.get({ sessionID: call.sessionID }).pipe(
          Effect.map((session) => session.location.directory),
          Effect.mapError(
            (error) =>
              new Tool.Error({
                message: "Could not read the session's directory",
                error,
              }),
          ),
        );

      // OpenCode's prompt only shows the action for plugin permissions, so the
      // action names the tool; rules match it with `upkeep.write *`.
      const assertWrite = (
        tool: ManifestTool,
        call: Tool.Context,
        input: string,
      ) => {
        if (tool.access !== "write") return Effect.void;

        const resource = `${namespace}_${tool.name}`;

        return context.permission.assert({
          sessionID: call.sessionID,
          agent: call.agent,
          action: `${namespace}.write ${tool.name}`,
          resources: [resource],
          // An empty save list keeps "always" from being stored, so the next call asks again.
          save: tool.alwaysAsk ? [] : [resource],
          metadata: { command: `upkeep ${tool.argv.join(" ")} ${input}` },
          source: { type: "tool", messageID: call.messageID, id: call.id },
        });
      };

      const execute =
        (tool: ManifestTool) =>
        (input: typeof Input.Type, call: Tool.Context) =>
          Effect.gen(function* () {
            const stdin = JSON.stringify(input);

            yield* assertWrite(tool, call, stdin);

            const stdout = yield* runUpkeep(tool.argv, {
              cwd: yield* sessionDirectory(call),
              stdin: tool.stdin ? stdin : undefined,
              timeout: tool.timeoutMillis,
              env: { OPENCODE_SESSION_ID: call.sessionID },
            });

            if (!tool.json) return { output: stdout.trimEnd() };

            return {
              output: yield* decodeJson(stdout).pipe(
                Effect.mapError(
                  (error) =>
                    new Tool.Error({
                      message: `upkeep ${tool.name} did not print JSON: ${error.message}`,
                    }),
                ),
              ),
            };
          });

      yield* context.tool.transform((draft) => {
        draft.namespace({
          name: namespace,
          description:
            "Upkeep: the jobs it runs, and runs and their logs on the server in $UPKEEP_SERVER, with the admin token in $UPKEEP_ADMIN_TOKEN.",
        });

        for (const tool of manifest.success) {
          const run = execute(tool);

          draft.add({
            name: tool.name,
            description: tool.description,
            input: strictInput(tool.input),
            output: tool.json ? Schema.Unknown : Schema.String,
            options:
              tool.access === "write"
                ? {
                    namespace,
                    codemode: true,
                    pinned: tool.pinned,
                    permission: `${namespace}.write`,
                  }
                : { namespace, codemode: true, pinned: tool.pinned },
            execute: (input, call) =>
              decodeInput(input).pipe(
                Effect.mapError(
                  (error) =>
                    new Tool.Error({
                      message: `Invalid input: ${error.message}`,
                    }),
                ),
                Effect.flatMap((decoded) => run(decoded, call)),
              ),
          });
        }
      });
    }),
});
