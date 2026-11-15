/**
 * The dashboard's PWA config: what `@timmo001/groundwork-pwa` gives it. The
 * build writes the manifest from it, and the page and service worker read it.
 */
import { definePwaConfig } from "@timmo001/groundwork-pwa";

export default definePwaConfig({
  name: "Upkeep",
  shortName: "Upkeep",
  description:
    "What needs doing across your repositories, and the jobs that do it",
  theme: "glazing",
  // The splash screen and task switcher take one colour, and the dashboard
  // leans dark
  mode: "dark",
  shortcuts: [
    { name: "Inbox", url: "./" },
    { name: "Activity", url: "./activity" },
    { name: "Jobs", url: "./jobs" },
    { name: "Releases", url: "./releases" },
  ],
  // Upkeep has nothing to do with a share, so it stays out of the share sheet
  shareTarget: false,
  offline: {
    // The built files are added by the build, which knows their hashed names
    shell: [
      "./",
      "manifest.webmanifest",
      "icons/icon-192.png",
      "icons/icon-512.png",
      "icons/maskable-512.png",
    ],
  },
  manifest: {
    categories: ["developer", "productivity"],
    launch_handler: { client_mode: "navigate-existing" },
  },
});
