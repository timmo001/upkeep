/**
 * What the server does for the dashboard as an installable app that holds
 * the rest of the server back from: it serves the service worker, manifest and
 * icons without the long cache the hashed assets get, and it turns away a
 * dashboard from another version than its own with a 426, so the page moves
 * itself onto the new release. Callers that don't say a version, such as the
 * CLI, workers and the page's event stream, are let through.
 */
import { versionHeader, versionMismatchStatus } from "@upkeep/api";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { version } from "./Version";

const pwaFile = /^(?:sw\.js|manifest\.webmanifest|icons\/.+)$/;

const contentTypes = new Map([
  ["js", "text/javascript; charset=utf-8"],
  ["webmanifest", "application/manifest+json"],
  ["png", "image/png"],
]);

/** The paths open to any version, so a client can always learn the server's. */
const anyVersion = new Set(["/api/health", "/api/version"]);

/**
 * Splits the PWA's files from the dashboard's other assets, as responses. The
 * worker must be fetched fresh for a new release to be noticed, and the icons
 * and manifest carry no hash, so none of them are cached for long.
 */
export const takePwaFiles = (bundled: Record<string, string>) => {
  const assets: Record<string, string> = {};
  const files = new Map<string, HttpServerResponse.HttpServerResponse>();

  for (const [name, body] of Object.entries(bundled)) {
    if (!pwaFile.test(name)) {
      assets[name] = body;
      continue;
    }

    const options = {
      contentType: contentTypes.get(name.split(".").pop() ?? ""),
      headers: { "cache-control": "no-cache" },
    };

    files.set(
      name,
      name.endsWith(".png")
        ? HttpServerResponse.uint8Array(Buffer.from(body, "base64"), options)
        : HttpServerResponse.text(body, options),
    );
  }

  return { assets, files };
};

/** Refuses an API call from a dashboard of another version, with a 426. */
export const versionGuard = <E, R>(
  httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
    const client = request.headers[versionHeader];
    const path = new URL(request.url, "http://upkeep").pathname;

    if (
      client === undefined ||
      client === version ||
      anyVersion.has(path) ||
      !path.startsWith("/api/")
    ) {
      return httpEffect;
    }

    return Effect.succeed(
      HttpServerResponse.jsonUnsafe(
        {
          message: `This page is Upkeep ${client} and the server runs ${version}, so it needs to reload.`,
          server: version,
          client,
        },
        { status: versionMismatchStatus },
      ),
    );
  });
