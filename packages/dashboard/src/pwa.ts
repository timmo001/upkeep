/**
 * The dashboard's PWA connection: registers the service worker and holds the
 * browser's install prompt for the banner and the app bar's button. Under
 * Home Assistant ingress, the page sits in an iframe at a path that changes
 * with each session, so there's nothing to install or keep offline.
 */
import { connectPwa } from "@timmo001/groundwork-pwa/view";
import config from "../pwa.config.ts";

const ingress = new URL(document.baseURI).pathname.startsWith(
  "/api/hassio_ingress/",
);

export const pwa = connectPwa(
  ingress ? { ...config, install: false, offline: false } : config,
);
