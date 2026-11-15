/**
 * Adds the PWA to the built dashboard: the manifest and icons from
 * `pwa.config.ts` and the logo, the service worker bundled to `sw.js` with the
 * page's hashed files to keep for offline starts, and the manifest link and
 * theme colours in the page's `<head>`. Runs after the page is built.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { headTags, writePwa } from "@timmo001/groundwork-pwa/build";
import config from "../pwa.config.ts";

const root = resolve(import.meta.dir, "..");
const outDir = resolve(process.env.DASHBOARD_OUT ?? "dist");
const build = process.env.UPKEEP_BUILD_VERSION ?? "dev";

const shell = readdirSync(outDir).filter((name) =>
  /\.(js|css|svg)$/.test(name),
);

const version = `${build}-${Bun.hash(shell.join()).toString(36)}`;

const worker = await Bun.build({
  entrypoints: [join(root, "src/sw.ts")],
  outdir: outDir,
  target: "browser",
  minify: true,
  naming: "[name].[ext]",
  define: {
    "process.env.GROUNDWORK_PWA_VERSION": JSON.stringify(version),
    "process.env.UPKEEP_PWA_SHELL": JSON.stringify(JSON.stringify(shell)),
  },
});

if (!worker.success) {
  for (const log of worker.logs) console.error(log);

  process.exit(1);
}

await writePwa(config, { outDir, logo: join(root, "favicon.svg") });

const page = join(outDir, "index.html");
const html = readFileSync(page, "utf8");

if (!html.includes("</title>")) {
  throw new Error("The built index.html has no <title> to add the PWA after");
}

writeFileSync(
  page,
  html.replace(
    "</title>",
    `</title>\n    ${headTags(config)}\n    <link rel="apple-touch-icon" href="icons/icon-192.png" />`,
  ),
);
