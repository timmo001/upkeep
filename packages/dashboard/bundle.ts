/**
 * Builds the dashboard and returns its files by name. The server imports it as
 * a Bun macro, so it runs while the binary is bundled or the server loads from
 * source, and the files end up inlined. Bun.build can't run inside a macro,
 * hence the child process.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const bundleDashboard = (): Record<string, string> => {
  const build = Bun.spawnSync([process.execPath, "run", "build"], {
    cwd: import.meta.dir,
    stdout: "ignore",
    stderr: "pipe",
  });

  if (!build.success) {
    throw new Error(`Couldn't build the dashboard: ${build.stderr.toString()}`);
  }

  const dist = join(import.meta.dir, "dist");

  return Object.fromEntries(
    readdirSync(dist).map((name) => [
      name,
      readFileSync(join(dist, name), "utf8"),
    ]),
  );
};
