/**
 * Adds the PWA to the built dashboard through groundwork's build: the
 * manifest and icons from `pwa.config.ts` and the logo, the service worker
 * bundled to `sw.js` with the page's hashed files to keep for offline starts,
 * and the manifest link and theme colours in the page's `<head>`, beside an
 * Apple touch icon. Runs after the page is built.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildPwa } from "@timmo001/groundwork-pwa/build";
import config from "../pwa.config.ts";

const root = resolve(import.meta.dir, "..");
const outDir = resolve(process.env.DASHBOARD_OUT ?? "dist");

await buildPwa(config, {
  outDir,
  worker: join(root, "src/sw.ts"),
  logo: join(root, "favicon.svg"),
});

const page = join(outDir, "index.html");

await writeFile(
  page,
  (await readFile(page, "utf8")).replace(
    "</title>",
    '</title>\n    <link rel="apple-touch-icon" href="icons/icon-192.png" />',
  ),
);
