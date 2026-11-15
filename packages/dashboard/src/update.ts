/**
 * Moving the page onto a new release, through groundwork's version watch. The
 * page says its version on each call and the server refuses a different one
 * with a 426, so once it does, the watch takes the new build from the service
 * worker and reloads onto it, once per version, and calls the page stale
 * where that didn't help.
 */
import {
  versionMismatchStatus,
  watchVersion,
} from "@timmo001/groundwork-pwa/update";
import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { pwa } from "./pwa.ts";

/** The page's watch on its version, for the stale banner. */
export const update = watchVersion({
  app: "upkeep",
  // The release it was built for, or `dev`
  version: process.env.UPKEEP_BUILD_VERSION ?? "dev",
  worker: pwa.worker,
});

/** Makes every call say this page's version, and tells the watch of a 426. */
export const versioned = (http: HttpClient.HttpClient): HttpClient.HttpClient =>
  http.pipe(
    HttpClient.mapRequest(HttpClientRequest.setHeaders(update.headers)),
    HttpClient.tap((response) =>
      Effect.sync(() => {
        if (response.status === versionMismatchStatus) update.mismatched();
      }),
    ),
  );
