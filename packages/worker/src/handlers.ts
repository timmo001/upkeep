/** What each job in the catalogue does on a worker, by job ID. */
import { attention } from "./jobs/attention";
import { attentionContext } from "./jobs/attention-context";
import { bump } from "./jobs/bump";
import { ci } from "./jobs/ci";
import { command as runCommand } from "./jobs/command";
import { deps } from "./jobs/deps";
import { drift } from "./jobs/drift";
import { heal } from "./jobs/heal";
import { labels } from "./jobs/labels";
import { machine } from "./jobs/machine";
import { notifications } from "./jobs/notifications";
import { releases } from "./jobs/releases";
import { skillChange } from "./jobs/skill-changes";
import { skillConsumers, skillUpdates } from "./jobs/skills";
import { stalledUpdates } from "./jobs/stalled-updates";
import { summary } from "./jobs/summary";
import { sync } from "./jobs/sync";
import { watch } from "./jobs/watch";
import type { Handlers } from "./Worker";

export const handlers: Handlers = {
  releases: () => releases(),
  watch: () => watch(),
  attention: () => attention(),
  labels: () => labels(),
  bump: (release) => bump(release),
  heal: () => heal(),
  notifications: () => notifications(),
  "stalled-updates": () => stalledUpdates(),
  drift: () => drift(),
  sync: () => sync(),
  deps: () => deps(),
  ci: () => ci(),
  "skill-consumers": () => skillConsumers(),
  "skill-updates": () => skillUpdates(),
  "skill-change": (_release, command) => skillChange(command),
  summary: () => summary(),
  "attention-context": () => attentionContext(),
  command: (_release, command) => runCommand(command),
  "up-dotfiles": () => machine("dotfiles"),
  "up-skills": () => machine("skills"),
  "up-repos": () => machine("repos"),
  "up-tools": () => machine("tools"),
  "up-plugins": () => machine("plugins"),
};
