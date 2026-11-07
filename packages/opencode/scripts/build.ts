/**
 * Compiles the TUI part's Solid JSX to plain JavaScript in dist/tui.js.
 * OpenCode installs the plugin under node_modules, where OpenTUI's runtime
 * Solid transform never runs, so loading src/tui.tsx there falls back to
 * Bun's React JSX and fails. Host modules stay external so the plugin uses
 * OpenCode's own copies.
 */
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

const result = await Bun.build({
  entrypoints: ["src/tui.tsx"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  plugins: [createSolidTransformPlugin()],
  external: [
    "@opencode/*",
    "@opentui/*",
    "solid-js",
    "solid-js/*",
    "effect",
    "effect/*",
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
