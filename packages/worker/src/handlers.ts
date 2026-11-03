/** What each job in the catalogue does on a worker, by job ID. */
import { bump } from "./jobs/bump";
import { digest } from "./jobs/digest";
import { heal } from "./jobs/heal";
import { labels } from "./jobs/labels";
import { releases } from "./jobs/releases";
import type { Handlers } from "./Worker";

export const handlers: Handlers = {
  releases: () => releases(),
  labels: () => labels(),
  bump: (release) => bump(release),
  heal: () => heal(),
  digest: () => digest(),
};
