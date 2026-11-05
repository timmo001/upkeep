/**
 * How the Attention page sorts items and says what moved, kept apart from the
 * store so the rules read in one place. Sections come from GitHub's signals,
 * with no model: what needs you, what's blocked, what's gone quiet, what
 * waits on others, and the rest.
 */
import { Domain } from "@upkeep/api";

const day = 86_400_000;

/** Signals that ask something of you. */
const needsYou: ReadonlySet<Domain.SignalKind> = new Set([
  "review-requested",
  "changes-requested",
  "unresolved",
  "new-comment",
  "mentioned",
]);

/** Signals that stop your own work going in. */
const blocking: ReadonlySet<Domain.SignalKind> = new Set([
  "failing-checks",
  "conflicts",
  "base-moved",
  "upkeep",
]);

/**
 * An item's section. What needs you comes first, then what's blocked. Your
 * drafts, and your issues nobody else has taken part in, are your backlog;
 * the rest of your own have gone quiet or wait on someone else. Everything
 * else is only watched. On your own, the shared status labels say more: a
 * decision waits on you, In Progress isn't backlog, and Blocked, On Hold or
 * Future is. The Blocked label means waiting on something else, so unlike
 * failing checks it has nothing for you to fix.
 */
export const sectionOf = (
  item: Pick<
    Domain.AttentionFound,
    "kind" | "signals" | "labels" | "yours" | "activityAt" | "involved"
  > & {
    /** The context agent's note says it's waiting on something for now. */
    readonly noted?: boolean;
  },
  now: number,
  staleDays: number,
): Domain.AttentionSection => {
  const quiet = now - item.activityAt >= staleDays * day;
  const kinds = new Set(item.signals.map((signal) => signal.kind));
  const status = item.yours ? Domain.statusOf(item.labels) : null;

  // A reply left longer than the stale window has gone quiet instead
  if (quiet) kinds.delete("new-comment");

  if (
    [...kinds].some((kind) => needsYou.has(kind)) ||
    status === "needs decision"
  )
    return "needs-you";

  if (item.yours && [...kinds].some((kind) => blocking.has(kind)))
    return "blocked";

  if (!item.yours) return "watching";

  if (
    status === "blocked" ||
    status === "on hold" ||
    status === "future" ||
    (status !== "in progress" &&
      (kinds.has("draft") || (item.kind === "issue" && !item.involved)))
  )
    return "backlog";

  return quiet && item.noted !== true ? "stale" : "waiting";
};

/** A piece of work GitHub's links make of some items, and what to call it. */
export interface Work {
  readonly urls: ReadonlyArray<string>;
  readonly name: string;
}

/**
 * The pieces of work GitHub's links make: items tied together, directly or
 * through a page that isn't an item itself, such as a shared parent issue.
 * Items in `apart` were grouped by hand, so they neither join nor bridge one.
 * Each is named after its most linked item, an issue before a pull request.
 */
export const workOf = (
  relations: ReadonlyArray<Domain.AttentionRelation>,
  items: ReadonlyArray<{
    readonly url: string;
    readonly kind: string;
    readonly title: string;
  }>,
  apart: ReadonlySet<string>,
): Array<Work> => {
  const leader = new Map<string, string>();

  const find = (url: string): string => {
    const next = leader.get(url);

    if (next === undefined || next === url) return url;

    const root = find(next);

    leader.set(url, root);

    return root;
  };

  const degree = new Map<string, number>();

  for (const { from, to } of relations) {
    if (apart.has(from) || apart.has(to)) continue;

    leader.set(find(from), find(to));
    degree.set(from, (degree.get(from) ?? 0) + 1);
    degree.set(to, (degree.get(to) ?? 0) + 1);
  }

  const pieces = new Map<string, Array<(typeof items)[number]>>();

  for (const item of items) {
    if (apart.has(item.url)) continue;

    const root = find(item.url);

    pieces.set(root, [...(pieces.get(root) ?? []), item]);
  }

  const named = (a: (typeof items)[number], b: (typeof items)[number]) =>
    (degree.get(b.url) ?? 0) - (degree.get(a.url) ?? 0) ||
    Number(b.kind === "issue") - Number(a.kind === "issue") ||
    a.url.localeCompare(b.url);

  return [...pieces.values()]
    .flatMap((piece) => {
      const [first] = piece.toSorted(named);

      return piece.length < 2 || first === undefined
        ? []
        : [{ urls: piece.map((item) => item.url), name: first.title }];
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));
};

/**
 * What moved between what was kept of an item and what was found now: the
 * signals that came and went, and a new title. An item found for the first
 * time is new; one whose fingerprint moved with nothing else to say was
 * updated.
 */
export const whatMoved = (
  before: Pick<Domain.AttentionFound, "signals" | "title"> | undefined,
  after: Pick<Domain.AttentionFound, "signals" | "title">,
) => {
  if (before === undefined) {
    return [
      "New",
      ...after.signals.map(
        (signal) => `New: ${Domain.signalLabel(signal.kind)}`,
      ),
    ];
  }

  const had = new Set(before.signals.map((signal) => signal.kind));
  const has = new Set(after.signals.map((signal) => signal.kind));

  const moved = [
    ...[...has].flatMap((kind) =>
      had.has(kind) ? [] : [`New: ${Domain.signalLabel(kind)}`],
    ),
    ...[...had].flatMap((kind) =>
      has.has(kind) ? [] : [`Cleared: ${Domain.signalLabel(kind)}`],
    ),
    ...(before.title === after.title ? [] : [`Renamed from ${before.title}`]),
  ];

  return moved.length === 0 ? ["Updated"] : moved;
};
