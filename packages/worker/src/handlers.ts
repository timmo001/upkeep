/** What each job in the catalogue does on a worker, by job ID. */
import { releases } from "./jobs/releases";
import type { Handlers } from "./Worker";

export const handlers: Handlers = {
  releases: () => releases(),
};
