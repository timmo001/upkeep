/**
 * The service worker, bundled to `sw.js`: keeps the app shell so the app
 * starts offline. The build lists the page's hashed files and sets
 * `GROUNDWORK_PWA_VERSION` from them, so each build's worker differs from the
 * last, replaces it and its cache, and takes over open pages by itself.
 */
import { resolveConfig } from "@timmo001/groundwork-pwa";
import {
  serveShell,
  type ShellWorkerScope,
} from "@timmo001/groundwork-pwa/worker";
import { Schema } from "effect";
import config from "../pwa.config.ts";

declare const self: ShellWorkerScope;

const builtFiles = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
)(process.env.UPKEEP_PWA_SHELL ?? "[]");

const offline = resolveConfig(config).offline;

const resolve = (path: string) => new URL(path, self.location.href).href;

// The server's own routes are live, so they always go to the network rather
// than being answered from the cache
const live = resolve("api/");

serveShell(
  self,
  {
    ...config,
    offline: {
      worker: "sw.js",
      shell: [...(offline === false ? [] : offline.shell), ...builtFiles],
    },
  },
  {
    version: process.env.GROUNDWORK_PWA_VERSION ?? "dev",
    routes: [
      ({ request }) =>
        request.url.startsWith(live) ? fetch(request) : undefined,
    ],
  },
);
