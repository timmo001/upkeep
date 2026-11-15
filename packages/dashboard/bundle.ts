/**
 * Builds the dashboard and returns its files by name, with a path for those in
 * a folder, such as `icons/icon-192.png`. The server imports it as a Bun
 * macro, so it runs while the binary is bundled or the server loads from
 * source, and the files end up inlined. Bun.build can't run inside a macro,
 * hence the child process. Each run builds into a directory of its own, as the
 * server's tests and the binary's build bundle it at the same time in CI.
 * Text files are as they are, and the PNG icons are base64.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const bundleDashboard = (): Record<string, string> => {
  const dist = mkdtempSync(join(tmpdir(), "upkeep-dashboard-"));

  try {
    const build = Bun.spawnSync([process.execPath, "run", "build"], {
      cwd: import.meta.dir,
      env: { ...process.env, DASHBOARD_OUT: dist },
      stdout: "ignore",
      stderr: "pipe",
    });

    if (!build.success) {
      throw new Error(
        `Couldn't build the dashboard: ${build.stderr.toString()}`,
      );
    }

    return Object.fromEntries(
      readdirSync(dist, { recursive: true, withFileTypes: true }).flatMap(
        (entry) => {
          if (!entry.isFile()) return [];

          const file = join(entry.parentPath, entry.name);

          return [
            [
              file.slice(dist.length + 1),
              readFileSync(
                file,
                entry.name.endsWith(".png") ? "base64" : "utf8",
              ),
            ],
          ];
        },
      ),
    );
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
};
