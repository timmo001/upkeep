/**
 * The environment the worker's child processes start with. A user service
 * starts at login, before the session's PATH has `~/.local/bin`, so `dot`
 * would resolve to Graphviz's and `opencode2` to nothing. Putting that
 * directory first when it's missing makes every child resolve them as the
 * user's shell does.
 */
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { Effect } from "effect";

/** Put `~/.local/bin` first on this process's PATH when it isn't on it. */
export const ensureLocalBin = (
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) => {
  const bin = join(home, ".local", "bin");
  const entries = (env.PATH ?? "").split(delimiter).filter(Boolean);

  if (entries.includes(bin)) return false;

  env.PATH = [bin, ...entries].join(delimiter);

  return true;
};

// Before any child process starts, whatever imports the worker
ensureLocalBin();

/**
 * Where a child process finds a command. `Bun.which` on its own searches the
 * PATH the process started with, missing `~/.local/bin` added above.
 */
export const which = (command: string) =>
  Bun.which(command, { PATH: process.env.PATH ?? "" });

/** Log which `dot` and `opencode2` child processes resolve to. */
export const logResolved = Effect.gen(function* () {
  for (const command of ["dot", "opencode2"])
    yield* Effect.logInfo(
      `${command} resolves to ${which(command) ?? "nothing on PATH"}`,
    );
});
