/**
 * The bar and footer lines for Upkeep's status, in the shape the desktop bar
 * and the OpenCode footer read, as `dot updates status` gives them: a text,
 * a tooltip and a class. Both count only what needs you.
 */
import type { Domain } from "@upkeep/api";

export interface Line {
  readonly text: string;
  readonly tooltip: string;
  readonly class: string;
}

const tooltip = (status: Domain.Status) =>
  [
    status.summary,
    ...status.needs.map((item) => `- ${item.title}`),
    status.workers.length === 0
      ? "No worker live"
      : `Workers: ${status.workers.join(", ")}`,
  ].join("\n");

/** The bar: the count that needs you, empty and hidden when nothing does. */
export const bar = (status: Domain.Status): Line => ({
  text:
    status.needs.length === 0
      ? status.health === "degraded"
        ? "!"
        : ""
      : String(status.needs.length),
  tooltip: tooltip(status),
  class: `upkeep-${status.health}`,
});

/** The OpenCode footer: the same count, named. */
export const footer = (status: Domain.Status): Line => ({
  text:
    status.needs.length === 0
      ? status.health === "degraded"
        ? "upkeep: no worker"
        : ""
      : `upkeep ${status.needs.length}`,
  tooltip: tooltip(status),
  class: `upkeep-${status.health}`,
});
