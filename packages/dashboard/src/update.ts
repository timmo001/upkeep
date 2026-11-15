/**
 * Moving the page onto a new release. The page says its version on each call
 * and the server refuses a different one with a 426, so once it does, the
 * service worker checks for the new build, which keeps its files and takes
 * over by itself, and the page reloads onto them. Without a worker, such as
 * over plain HTTP on the network, the reload fetches them itself. It does so
 * once per version, and says so in a banner where that didn't help.
 */
import { versionHeader, versionMismatchStatus } from "@upkeep/api";
import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { pwa } from "./pwa.ts";

/** This page's version: the release it was built for, or `dev`. */
export const version = process.env.UPKEEP_BUILD_VERSION ?? "dev";

/** Fired on the window when a reload didn't bring the page onto the server's version. */
export const outdatedEvent = "upkeep-outdated";

const reloadedKey = "upkeep:reloaded-for-version";

/** How long a new worker gets to take over before the page reloads anyway. */
const takeOverTimeout = 10_000;

let updating = false;

let outdated = false;

/** Whether the server runs another version than this page, after a reload. */
export const isOutdated = () => outdated;

const reloadForUpdate = async () => {
  const registration = await pwa.worker;

  if (
    registration !== undefined &&
    navigator.serviceWorker.controller !== null
  ) {
    const takenOver = new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () =>
        resolve(),
      );
      setTimeout(resolve, takeOverTimeout);
    });

    await registration.update().catch(() => undefined);

    if (registration.installing !== null || registration.waiting !== null) {
      await takenOver;
    }
  }

  location.reload();
};

const whenMismatched = () => {
  if (updating || outdated) return;

  if (sessionStorage.getItem(reloadedKey) !== version) {
    sessionStorage.setItem(reloadedKey, version);
    updating = true;
    void reloadForUpdate();

    return;
  }

  outdated = true;
  window.dispatchEvent(new Event(outdatedEvent));
};

/** Makes every call say this page's version, and tells `whenMismatched` of a 426. */
export const versioned = (http: HttpClient.HttpClient): HttpClient.HttpClient =>
  http.pipe(
    HttpClient.mapRequest(HttpClientRequest.setHeader(versionHeader, version)),
    HttpClient.tap((response) =>
      Effect.sync(() => {
        if (response.status === versionMismatchStatus) whenMismatched();
      }),
    ),
  );
