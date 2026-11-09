/**
 * Which jobs a GitHub event starts, and the files that decide some of them.
 * The server queues what this asks for once it has checked the repository is
 * tracked; the worker reads the same file names, so the two agree.
 */
import * as Catalogue from "./Catalogue";
import type { GitHubEvent, JobId } from "./Domain";

/** The file at a repository root that records its reviewed tool releases. */
export const toolingFile = "tooling.yml";

/** Where Renovate looks for a repository's config, in its order. */
export const renovateConfigFiles: ReadonlyArray<string> = [
  "renovate.json",
  "renovate.json5",
  ".github/renovate.json",
  ".github/renovate.json5",
  ".gitlab/renovate.json",
  ".gitlab/renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
  ".renovaterc.json5",
];

/**
 * The repository that publishes the first-party Arch packages, and the
 * workflow that publishes them. Each successful publish has every worker
 * upgrade its own machine.
 */
export const packageRepository = "arch-repo";

export const packageWorkflow = "Publish package";

/** A run an event asks for: for its repository, or for every one. */
export interface EventRun {
  readonly job: JobId;
  /** The repository to narrow it to, or null for the whole job. */
  readonly repo: string | null;
}

/**
 * The runs an event asks for, before the server checks what's tracked:
 *
 * - a push to the default branch: `watch` for the repository; `sync` for the
 *   whole job on groundwork, or for the repository on an app that may take
 *   copies from it; `skill-consumers` on the skills repository; and `deps`
 *   or `drift` when it changed the dependency config or `tooling.yml`, or
 *   more paths than the event lists;
 * - a workflow run completing on the default branch: `ci` for the repository,
 *   and `up-first-party` on every worker when it's a successful publish of
 *   the first-party Arch packages.
 *
 * Upkeep's own pushes come back too. Each is cheap: watch already knows its
 * commits, and deps and drift only run again when a push changed their
 * config, where they find nothing left to do.
 */
export const runsFor = (event: GitHubEvent): ReadonlyArray<EventRun> => {
  const name = event.repo.split("/").at(-1)?.toLowerCase();
  const own = { repo: event.repo };

  if (event.event === "push") {
    if (
      event.defaultBranch === null ||
      event.ref !== `refs/heads/${event.defaultBranch}`
    )
      return [];

    const changed = (matches: (path: string) => boolean) =>
      event.truncated || event.paths.some(matches);

    return [
      { job: Catalogue.watch.id, ...own },
      name === "groundwork"
        ? { job: Catalogue.sync.id, repo: null }
        : { job: Catalogue.sync.id, ...own },
      ...(name === "skills"
        ? [{ job: Catalogue.skillConsumers.id, repo: null }]
        : []),
      ...(changed((path) => renovateConfigFiles.includes(path))
        ? [{ job: Catalogue.deps.id, ...own }]
        : []),
      ...(changed((path) => path === toolingFile)
        ? [{ job: Catalogue.drift.id, ...own }]
        : []),
    ];
  }

  if (
    event.event === "workflow_run" &&
    event.action === "completed" &&
    event.defaultBranch !== null &&
    event.workflow?.branch === event.defaultBranch
  )
    return [
      { job: Catalogue.ci.id, ...own },
      ...(name === packageRepository &&
      event.workflow.name === packageWorkflow &&
      event.workflow.conclusion === "success"
        ? [{ job: Catalogue.upFirstParty.id, repo: null }]
        : []),
    ];

  return [];
};
