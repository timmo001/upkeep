/**
 * Every job Upkeep knows, shared so the server schedules the same list the
 * workers can run and the CLI shows.
 */
import type { Job } from "./Domain";

export const releases: Job = {
  id: "releases",
  name: "Releases",
  description:
    "Check the latest release of each repository and queue the jobs that run on a new one",
  schedule: "*/30 * * * *",
  onRelease: false,
  lane: "quick",
  tracked: true,
};

export const labels: Job = {
  id: "labels",
  name: "Labels",
  description:
    "Bring each repository's labels in line with the groundwork conventions",
  schedule: "0 4 * * *",
  onRelease: false,
  lane: "quick",
  tracked: true,
};

export const bump: Job = {
  id: "bump",
  name: "Bump",
  description:
    "Roll a new release out to the repositories that pin or depend on it, checking and pushing each one",
  schedule: null,
  onRelease: true,
  lane: "repos",
  tracked: true,
};

export const heal: Job = {
  id: "heal",
  name: "Heal",
  description:
    "Fix a failed or lost run: retry it, hand it to an agent, park the job or ask",
  schedule: null,
  onRelease: false,
  lane: "heal",
  tracked: false,
};

export const digest: Job = {
  id: "digest",
  name: "Digest",
  description: "Send the day's heals to the Inbox as one message",
  schedule: "0 20 * * *",
  onRelease: false,
  lane: "quick",
  tracked: false,
};

export const notifications: Job = {
  id: "notifications",
  name: "Notifications",
  description:
    "Dismiss the GitHub notifications of dependency updates that have merged",
  schedule: "*/15 * * * *",
  onRelease: false,
  lane: "quick",
  tracked: true,
};

export const stalledUpdates: Job = {
  id: "stalled-updates",
  name: "Stalled updates",
  description:
    "Take over dependency update pull requests whose checks failed: push each update to the default branch and close the pull request",
  schedule: "0 * * * *",
  onRelease: false,
  lane: "repos",
  tracked: true,
};

export const drift: Job = {
  id: "drift",
  name: "Drift",
  description:
    "Check each repository's tooling.yml against the latest releases of its tools: push the pin moves that need no review, and fail with what to review for the rest",
  schedule: "0 */6 * * *",
  onRelease: false,
  lane: "repos",
  tracked: true,
};

export const deps: Job = {
  id: "deps",
  name: "Dependencies",
  description:
    "Read each repository's dependency updater config and log the groups of updates it would open, with who owns each. Changes nothing yet",
  schedule: "0 */6 * * *",
  onRelease: false,
  lane: "repos",
  tracked: true,
};

export const ci: Job = {
  id: "ci",
  name: "CI",
  description:
    "Read the latest CI on each repository's default branch: run the checks of a red one here and fail with both, so a heal fixes it forward",
  schedule: "30 * * * *",
  onRelease: false,
  lane: "repos",
  tracked: true,
};

export const jobs: ReadonlyArray<Job> = [
  releases,
  labels,
  bump,
  heal,
  digest,
  notifications,
  stalledUpdates,
  drift,
  deps,
  ci,
];
