/**
 * Where a commit goes in the inbox: which entry it joins, what kind of entry
 * that is and whether it's routine. A run's own commits are placed by what
 * the run was doing; the watch job's come with their place already set.
 */
import { Catalogue, type Domain } from "@upkeep/api";

/** Where a commit goes, and how it reads there. */
export interface Placement {
  /** The entry it joins; the same key is the same change elsewhere. */
  readonly key: string;
  readonly kind: Domain.EntryKind;
  readonly title: string;
  readonly routine: boolean;
  readonly you: boolean;
  /** What it says for its repository. */
  readonly text: string;
}

/** The entry of a first-party release, which its bumps and fixes join. */
export const releaseKey = (release: {
  readonly repo: string;
  readonly tag: string;
}) => `release:${release.repo.toLowerCase()}@${release.tag}`;

/** A release by its repository's short name, such as `groundwork 0.9.33`. */
export const releaseTitle = (release: {
  readonly repo: string;
  readonly tag: string;
}) => `${release.repo.split("/").at(-1) ?? release.repo} ${release.tag}`;

/** A pull request's subject without its number, so the same update matches. */
export const withoutNumber = (subject: string) =>
  subject.replace(/\s*\(#\d+\)$/, "");

const jobName = (id: string) =>
  Catalogue.jobs.find((job) => job.id === id)?.name ?? id;

/**
 * Place a commit. A heal's fix joins the release it was fixing, when it was
 * one, so a release reads as one entry with every consumer and fix in it.
 * Otherwise the run's job decides, unless the commit carries its own place.
 */
export const placement = (
  change: Domain.Change,
  run: Domain.Run | null,
): Placement => {
  const commit: Placement = {
    key: `commit:${change.repo.toLowerCase()}@${change.sha}`,
    kind: "commit",
    title: change.subject,
    routine: false,
    you: false,
    text: change.subject,
  };

  if (run?.heal) {
    const { release } = run;

    return release === null
      ? {
          ...commit,
          key: `fix:${run.heal.job}:${change.repo.toLowerCase()}`,
          kind: "fix",
          title: `Upkeep fixed ${jobName(run.heal.job)} in ${change.repo.split("/").at(-1) ?? change.repo}`,
        }
      : {
          ...commit,
          key: releaseKey(release),
          kind: "release",
          title: releaseTitle(release),
          text: `Fixed: ${change.subject}`,
        };
  }

  if (change.group !== undefined) {
    return {
      ...commit,
      key: change.group,
      kind: change.kind ?? "commit",
      title: change.title ?? change.subject,
      routine: change.routine ?? false,
      you: change.you ?? false,
    };
  }

  switch (run?.job) {
    case Catalogue.bump.id:
      return run.release === null
        ? commit
        : {
            ...commit,
            key: releaseKey(run.release),
            kind: "release",
            title: releaseTitle(run.release),
          };

    case Catalogue.drift.id:
      return {
        ...commit,
        key: `drift:${change.subject}`,
        kind: "drift",
        routine: true,
      };

    case Catalogue.stalledUpdates.id: {
      const subject = withoutNumber(change.subject);

      return {
        ...commit,
        key: `update:${subject}`,
        kind: "update",
        title: subject,
        routine: true,
      };
    }

    default:
      return commit;
  }
};
