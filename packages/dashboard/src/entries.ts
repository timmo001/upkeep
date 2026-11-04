/**
 * How inbox entries read: repository titles, what an entry did as a heading
 * and a line, its kind, the day it belongs to, and the summary of what's
 * new. Shared by the inbox and the repository pages.
 */
import type { Domain } from "@upkeep/api";

/** Repository titles by `owner/name`, lower-cased. */
export type Titles = ReadonlyMap<string, string>;

/** Titles from the tracked repositories, by lower-cased `owner/name`. */
export const titlesOf = (repos: ReadonlyArray<Domain.TrackedRepo>): Titles =>
  new Map(
    repos.flatMap((repo) =>
      repo.title === null ? [] : [[repo.repo.toLowerCase(), repo.title]],
    ),
  );

/** A repository's title, or its name when it has none. */
export const titleOf = (repo: string, titles: Titles) =>
  titles.get(repo.toLowerCase()) ?? repo.split("/").at(-1) ?? repo;

/** The distinct repositories an entry reached, by title. */
export const reposOf = (entry: Domain.Entry, titles: Titles) => [
  ...new Set(entry.items.map((item) => titleOf(item.repo, titles))),
];

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** A list in words: "a, b and c". */
export const listed = (words: ReadonlyArray<string>) =>
  words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

/** Commits that say little on their own, left out of a summary. */
const filler =
  /^(Release |Merge |Bump version|Update (dependency |lockfile|\S+ (digest|action))|Format|Lint|wip$)/i;

export const fixesOf = (entry: Domain.Entry) =>
  entry.items.filter((item) => item.text.startsWith("Fixed:"));

/**
 * What an entry did, as a heading and a line under it. Commits lead with
 * their newest change worth reading and list the next few; a release says
 * where it went; an update or drift move, which repositories it reached.
 */
export const describe = (entry: Domain.Entry, titles: Titles) => {
  const repos = reposOf(entry, titles);

  switch (entry.kind) {
    case "commit": {
      const newest = entry.items.toReversed();
      const worth = newest.filter((item) => !filler.test(item.text));
      const shown = worth.length > 0 ? worth : newest;
      const [lead, ...rest] = shown.map((item) => item.text);
      const more = entry.items.length - 1 - Math.min(rest.length, 3);

      return {
        heading: `${repos[0] ?? "?"}: ${lead ?? entry.title}`,
        description: [
          ...rest.slice(0, 3),
          ...(more > 0 ? [plural(more, "more commit")] : []),
        ].join(" · "),
      };
    }

    case "release": {
      const fixed = fixesOf(entry);

      return {
        heading:
          repos.length === 0
            ? `${entry.title} released`
            : `${entry.title} reached ${plural(repos.length, "repository", "repositories")}`,
        description: [
          listed(repos),
          ...(fixed.length > 0
            ? [`${plural(fixed.length, "fix", "fixes")} by Upkeep`]
            : []),
        ]
          .filter((part) => part !== "")
          .join(" · "),
      };
    }

    default:
      return {
        heading: entry.title,
        description:
          repos.length > 4
            ? plural(repos.length, "repository", "repositories")
            : listed(repos),
      };
  }
};

export const kinds: Record<
  Domain.EntryKind,
  { readonly label: string; readonly tone: string }
> = {
  needs: { label: "Needs you", tone: "warning" },
  release: { label: "Release", tone: "accent" },
  update: { label: "Update", tone: "info" },
  drift: { label: "Drift", tone: "info" },
  fix: { label: "Fixed by Upkeep", tone: "success" },
  commit: { label: "Commits", tone: "neutral" },
};

/** The day an entry belongs to, as the feed's heading. */
export const dayOf = (millis: number) => {
  const day = new Date(millis).toDateString();
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);

  if (day === today.toDateString()) return "Today";

  if (day === yesterday.toDateString()) return "Yesterday";

  return new Date(millis).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
};

/**
 * A few sentences on what's new: releases and where they went, what you
 * changed and where, updates that needed a change, the routine count, and
 * whether anything needs you.
 */
export const summarise = (
  fresh: ReadonlyArray<Domain.Entry>,
  needs: number,
  titles: Titles,
) => {
  const sentences: Array<string> = [];
  const releases = fresh.filter((entry) => entry.kind === "release");

  for (const release of releases.slice(0, 3)) {
    sentences.push(`${describe(release, titles).heading}.`);
  }

  if (releases.length > 3) {
    sentences.push(`${plural(releases.length - 3, "more release")} went out.`);
  }

  const yours = fresh.filter((entry) => entry.you && !entry.routine);

  if (yours.length > 0) {
    const byRepo = new Map<string, number>();

    for (const entry of yours) {
      for (const repo of reposOf(entry, titles)) {
        byRepo.set(repo, (byRepo.get(repo) ?? 0) + entry.items.length);
      }
    }

    const busiest = [...byRepo]
      .toSorted(([, a], [, b]) => b - a)
      .slice(0, 4)
      .map(([repo, count]) => `${repo} (${count})`);

    sentences.push(
      `You pushed to ${listed(busiest)}${byRepo.size > 4 ? ` and ${byRepo.size - 4} more` : ""}.`,
    );
  }

  const others = fresh.filter(
    (entry) => entry.kind === "commit" && !entry.you && !entry.routine,
  );

  if (others.length > 0) {
    sentences.push(
      `Others pushed to ${listed([...new Set(others.flatMap((entry) => reposOf(entry, titles)))].slice(0, 4))}.`,
    );
  }

  const changed = fresh.filter(
    (entry) =>
      (entry.kind === "update" || entry.kind === "drift") && !entry.routine,
  );

  if (changed.length > 0) {
    sentences.push(
      `${plural(changed.length, "update")} needed a code or config change.`,
    );
  }

  const fixed = fresh.filter((entry) => entry.kind === "fix");

  if (fixed.length > 0) {
    sentences.push(
      `Upkeep fixed ${listed(fixed.flatMap((entry) => reposOf(entry, titles)))}.`,
    );
  }

  const routine = fresh.filter((entry) => entry.routine);

  if (routine.length > 0) {
    sentences.push(
      `${plural(routine.length, "version bump")} across ${plural(new Set(routine.flatMap((entry) => reposOf(entry, titles))).size, "repository", "repositories")} changed no code.`,
    );
  }

  sentences.push(
    needs === 0
      ? "Nothing needs you."
      : `${needs === 1 ? "One thing needs" : `${needs} things need`} you.`,
  );

  return sentences.join(" ");
};
