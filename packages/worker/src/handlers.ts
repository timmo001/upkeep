/** What each job in the catalogue does on a worker, by job ID. */
import { bump } from "./jobs/bump";
import { ci } from "./jobs/ci";
import { deps } from "./jobs/deps";
import { digest } from "./jobs/digest";
import { drift } from "./jobs/drift";
import { heal } from "./jobs/heal";
import { labels } from "./jobs/labels";
import { notifications } from "./jobs/notifications";
import { releases } from "./jobs/releases";
import { stalledUpdates } from "./jobs/stalled-updates";
import { watch } from "./jobs/watch";
import type { Handlers } from "./Worker";

export const handlers: Handlers = {
  releases: () => releases(),
  watch: () => watch(),
  labels: () => labels(),
  bump: (release) => bump(release),
  heal: () => heal(),
  digest: () => digest(),
  notifications: () => notifications(),
  "stalled-updates": () => stalledUpdates(),
  drift: () => drift(),
  deps: () => deps(),
  ci: () => ci(),
};
