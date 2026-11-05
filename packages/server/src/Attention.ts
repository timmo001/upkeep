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
 * else is only watched.
 */
export const sectionOf = (
  item: Pick<
    Domain.AttentionFound,
    "kind" | "signals" | "yours" | "activityAt" | "involved"
  >,
  now: number,
  staleDays: number,
): Domain.AttentionSection => {
  const quiet = now - item.activityAt >= staleDays * day;
  const kinds = new Set(item.signals.map((signal) => signal.kind));

  // A reply left longer than the stale window has gone quiet instead
  if (quiet) kinds.delete("new-comment");

  if ([...kinds].some((kind) => needsYou.has(kind))) return "needs-you";

  if (item.yours && [...kinds].some((kind) => blocking.has(kind)))
    return "blocked";

  if (!item.yours) return "watching";

  if (kinds.has("draft") || (item.kind === "issue" && !item.involved))
    return "backlog";

  return quiet ? "stale" : "waiting";
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
