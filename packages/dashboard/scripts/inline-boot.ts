/**
 * Puts groundwork's theme boot script inline in the built page's `<head>`, so
 * the stored theme and mode apply before the first paint and nothing
 * flashes. Bun would otherwise bundle it into the module script, which only
 * runs once the page has painted.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { themeBootScript } from "@timmo001/groundwork-tokens/page";
import { themeOptions } from "../src/theme-options.ts";

const page = join(resolve(process.env.DASHBOARD_OUT ?? "dist"), "index.html");
const html = readFileSync(page, "utf8");

if (!html.includes("</title>")) {
  throw new Error("The built index.html has no <title> to boot after");
}

writeFileSync(
  page,
  html.replace(
    "</title>",
    `</title>\n    <script>${themeBootScript(themeOptions)}</script>`,
  ),
);
