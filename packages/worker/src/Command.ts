/**
 * Running a command on the worker's machine, for the jobs and the decision
 * model alike. It lives on its own so the modules that run commands don't
 * have to import a job to do it.
 */
import { stripVTControlCharacters } from "node:util";
import { Effect, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** A line mise prefixes with its task's name, and the one saying it failed. */
const taskLine = /^\[([^\]]+)\] /;
const taskFailed = /^\[([^\]]+)\] ERROR /;

/**
 * The part of a failed command's output worth showing. mise runs tasks in
 * parallel and prefixes each line with its task, so when several tasks wrote
 * and one failed, that's the failed task's own last 40 lines and mise's error
 * line, without colours. Otherwise it's the last 20 lines.
 */
export const failedOutput = (output: string) => {
  const lines = output.trim().split("\n");
  const plain = lines.map((line) => stripVTControlCharacters(line));
  const errors = plain.filter((line) => taskFailed.test(line));

  const failed = new Set(
    errors.flatMap((line) => taskFailed.exec(line)?.[1] ?? []),
  );

  const tasks = new Set(
    plain.flatMap((line) => taskLine.exec(line)?.[1] ?? []),
  );

  // A task run on its own isn't prefixed, so its error would be filtered out
  if (failed.size === 0 || tasks.size < 2) return lines.slice(-20).join("\n");

  const own = plain.filter(
    (line) =>
      !taskFailed.test(line) && failed.has(taskLine.exec(line)?.[1] ?? ""),
  );

  return [...own.slice(-40), ...errors].join("\n");
};

class CommandFailed extends Schema.TaggedError<CommandFailed>()(
  "CommandFailed",
  {
    command: Schema.String,
    exitCode: Schema.Int,
    output: Schema.String,
  },
) {
  override get message() {
    const tail = failedOutput(this.output);

    return `${this.command} exited with ${this.exitCode}${tail === "" ? "" : `\n${tail}`}`;
  }
}

const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

/**
 * How GitHub fails for a moment: SSH refusing a key it accepts a minute
 * later, a remote that can't be read, a 5xx or a lazy fetch of a missing
 * object. Worth retrying rather than failing the repository over.
 */
const transient =
  /Permission denied \(publickey\)|Could not read from remote repository|Internal Server Error|fatal error in commit_refs|could not fetch [0-9a-f]+ from promisor remote|Connection (?:reset|timed out|closed)|returned error: 5\d\d/;

/**
 * Run a command to the end and return its stdout, failing with its output on
 * a non-zero exit. Clones live under the cache root, which mise is told to
 * trust, and nothing may prompt, so it gets no stdin. A git command that fails on a GitHub blip
 * is tried again, up to four more times over about two minutes.
 */
export const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly trusted: string },
) =>
  runOnce(command, args, options).pipe(
    Effect.retry({
      while: (error) =>
        error instanceof CommandFailed &&
        error.command.startsWith("git ") &&
        transient.test(error.output),
      schedule: Schedule.exponential("5 seconds"),
      times: 4,
    }),
  );

const runOnce = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly trusted: string },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const label = [command, ...args].join(" ");

  const [stdout, stderr, exitCode] = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          cwd: options.cwd,
          // Nothing may prompt, and a command that reads a piped stdin, such
          // as `opencode run`, would wait on it forever
          stdin: "ignore",
          extendEnv: true,
          env: {
            MISE_TRUSTED_CONFIG_PATHS: options.trusted,
            MISE_YES: "1",
            GIT_TERMINAL_PROMPT: "0",
            CI: "1",
          },
        }),
      );

      return yield* Effect.all(
        [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
    }),
  );

  if (Number(exitCode) !== 0) {
    return yield* new CommandFailed({
      command: label,
      exitCode: Number(exitCode),
      output: `${stderr}\n${stdout}`,
    });
  }

  return stdout;
});
