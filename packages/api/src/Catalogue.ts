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
};

export const labels: Job = {
  id: "labels",
  name: "Labels",
  description:
    "Bring each repository's labels in line with the groundwork conventions",
  schedule: "0 4 * * *",
  onRelease: false,
};

export const bump: Job = {
  id: "bump",
  name: "Bump",
  description:
    "Roll a new release out to the repositories that pin or depend on it, checking and pushing each one",
  schedule: null,
  onRelease: true,
};

export const heal: Job = {
  id: "heal",
  name: "Heal",
  description:
    "Fix a failed or lost run: retry it, hand it to an agent, park the job or ask",
  schedule: null,
  onRelease: false,
};

export const digest: Job = {
  id: "digest",
  name: "Digest",
  description: "Send the day's heals to the Inbox as one message",
  schedule: "0 20 * * *",
  onRelease: false,
};

export const jobs: ReadonlyArray<Job> = [releases, labels, bump, heal, digest];
