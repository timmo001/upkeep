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

export const unreleased: Job = {
  id: "unreleased",
  name: "Unreleased changes",
  description:
    "Compare each repository's branch with its last stable release, classify what changed and suggest the release it needs, for the Releases page",
  schedule: "*/15 * * * *",
  onRelease: false,
  lane: "checks",
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

export const driftReview: Job = {
  id: "drift-review",
  name: "Drift review",
  description:
    "On request, have an agent review each repository as a whole against the current release of every tool in its tooling.yml, for what it's still missing, not only what changed since the last review",
  schedule: null,
  onRelease: false,
  lane: "checks",
  tracked: false,
  trackedAs: drift.id,
};

export const sync: Job = {
  id: "sync",
  name: "Sync",
  description:
    "Keep the copies apps take from groundwork current: carry an app's QML edits back, copy groundwork's changes out, then check and push each one",
  schedule: "15 * * * *",
  onRelease: false,
  lane: "repos",
  tracked: true,
};

export const deps: Job = {
  id: "deps",
  name: "Dependencies",
  description:
    "Read each repository's dependency updater config and plan the groups of updates it would open, with who owns each, then apply, check and push them in the repositories set to apply",
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
  lane: "checks",
  tracked: true,
};

export const watch: Job = {
  id: "watch",
  name: "Watch",
  description:
    "Read what landed on each tracked repository's default branch, by anyone, for the inbox: your commits, merged updates and anything else outside Upkeep's own runs",
  schedule: "*/15 * * * *",
  onRelease: false,
  lane: "quick",
  tracked: false,
};

export const skillConsumers: Job = {
  id: "skill-consumers",
  name: "Skill consumers",
  description:
    "Sync the shared skills into the repositories listed in the skills repository's consumers.yml",
  schedule: "25 * * * *",
  onRelease: false,
  lane: "repos",
  tracked: false,
};

export const skillUpdates: Job = {
  id: "skill-updates",
  name: "Skill updates",
  description:
    "Check the shared skills against their upstreams and tools, pushing the updates that need no review and giving the rest to an agent to hold for your approval",
  schedule: "40 * * * *",
  onRelease: false,
  lane: "repos",
  tracked: false,
};

export const skillChange: Job = {
  id: "skill-change",
  name: "Skill change",
  description:
    "Have an agent change a skill and hold its patch for your approval, or land, revise or start again on a held change",
  schedule: null,
  onRelease: false,
  lane: "agent",
  tracked: false,
};

export const change: Job = {
  id: "change",
  name: "Change",
  description:
    "On request, have one agent make the same change across several repositories in one session, checking and pushing each",
  schedule: null,
  onRelease: false,
  lane: "agent",
  tracked: false,
};

export const summary: Job = {
  id: "summary",
  name: "Summary",
  description:
    "Ask an agent for a longer write-up of what's in the inbox, on request from the dashboard",
  schedule: null,
  onRelease: false,
  lane: "quick",
  tracked: false,
};

export const attention: Job = {
  id: "attention",
  name: "Attention",
  description:
    "Read the pull requests, issues and notifications that involve you, and the open ones on tracked repositories, for the Attention page",
  schedule: "*/15 * * * *",
  onRelease: false,
  lane: "quick",
  tracked: false,
};

export const attentionContext: Job = {
  id: "attention-context",
  name: "Attention context",
  description:
    "Ask an agent for a note on each Attention item that changed, a follow-up on groups whose items went, and what to do about your comments",
  schedule: "0 */3 * * *",
  onRelease: false,
  lane: "quick",
  tracked: false,
};

export const command: Job = {
  id: "command",
  name: "Command",
  description:
    "Do one thing the dashboard asks, such as mark a notification read or start an agent",
  schedule: null,
  onRelease: false,
  lane: "command",
  tracked: false,
};

/**
 * A machine job: one `dot up` stage, run headless on every live worker so
 * each machine keeps itself current without `dot up`.
 */
const machine = (
  stage: string,
  name: string,
  description: string,
  schedule: string,
): Job => ({
  id: `up-${stage}`,
  name,
  description: `${description}, on every worker, through \`dot up ${stage}\``,
  schedule,
  onRelease: false,
  lane: "machine",
  tracked: false,
  machine: true,
});

export const upDotfiles = machine(
  "dotfiles",
  "Dotfiles",
  "Pull the dotfiles, rebuild dot and stow what changed",
  "5 * * * *",
);

export const upSkills = machine(
  "skills",
  "Skills",
  "Move the shared skills to the latest main and relink them, reloading agents when they changed",
  "50 * * * *",
);

export const upRepos = machine(
  "repos",
  "Repositories",
  "Pull the tracked repositories that are behind and have no work in progress",
  "20,50 * * * *",
);

export const upTools = machine(
  "tools",
  "Tools",
  "Install and upgrade mise tools",
  "10 5 * * *",
);

export const upPlugins = machine(
  "plugins",
  "Agent plugins",
  "Update the Pi, Plannotator and OpenCode plugins, reloading agents when they changed",
  "20 5 * * *",
);

/** The machine jobs, in the order a worker catching up runs them. */
export const machineJobs: ReadonlyArray<Job> = [
  upDotfiles,
  upSkills,
  upRepos,
  upTools,
  upPlugins,
];

/**
 * Whether a run of a job can be narrowed to one repository: the jobs that
 * work on the repositories tracked for them, and watch, which reads every
 * tracked repository.
 */
export const scopable = (job: Job) =>
  job.tracked || job.trackedAs !== undefined || job.id === watch.id;

/**
 * The job a repository has to be tracked for to be worked on by this one: the
 * job itself, the one it borrows (`trackedAs`), or none, for a job that
 * works on every tracked repository or none.
 */
export const trackingJob = (job: Job) =>
  job.trackedAs ?? (job.tracked ? job.id : null);

export const jobs: ReadonlyArray<Job> = [
  releases,
  unreleased,
  watch,
  attention,
  labels,
  bump,
  heal,
  notifications,
  stalledUpdates,
  drift,
  driftReview,
  sync,
  deps,
  ci,
  skillConsumers,
  skillUpdates,
  skillChange,
  change,
  summary,
  attentionContext,
  command,
  ...machineJobs,
];
