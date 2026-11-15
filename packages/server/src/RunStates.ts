/**
 * How a failed run's state follows its heals and later runs, and what a heal
 * run ends as. The store applies these as runs finish; the backfill applies
 * them once to the runs from before there were such states.
 */
import { Domain } from "@upkeep/api";

export type HealResult = (typeof Domain.healResults)[number];

const results: ReadonlySet<Domain.RunState> = new Set(Domain.healResults);

export const isHealResult = (state: Domain.RunState): state is HealResult =>
  results.has(state);

/** What a heal had done by the time it ended. */
export interface HealEnd {
  readonly attention: boolean;
  readonly decision: Domain.HealDecision | null;
  readonly actions: ReadonlyArray<string>;
  readonly commit: string | null;
  /** The run it queued again, when it did. */
  readonly retry: string | null;
  /** Whether it pushed anything. */
  readonly changed: boolean;
}

/** A heal's action that queued the job again, with the new run's ID. */
const queuedAgain = /^Queued \S+ again as ([0-9A-Za-z]+)/;

/** The retry a heal's actions say it queued, for heals from before the link. */
export const retryOf = (actions: ReadonlyArray<string>) =>
  actions.map((action) => queuedAgain.exec(action)?.[1]).find(Boolean) ?? null;

const leftForYou = [
  "Left for you",
  "The agent needs a person",
  "The agent ran out of",
];

/**
 * What a heal run ends as. A heal that parked the job, or found it parked when
 * it went to retry, is `parked`; one that left something for a person is
 * `needs-you`, as is one whose actions say so after the person dismissed it.
 */
export const healResult = (heal: HealEnd, failed: boolean): HealResult => {
  if (failed) return "failed";

  if (
    heal.decision === "park" ||
    heal.actions.some(
      (action) =>
        action.startsWith("Parked ") || action.startsWith("Didn't queue "),
    )
  )
    return "parked";

  if (
    heal.attention ||
    heal.actions.some((action) =>
      leftForYou.some((start) => action.startsWith(start)),
    )
  )
    return "needs-you";

  if (heal.retry !== null || heal.actions.some((a) => queuedAgain.test(a)))
    return "retried";

  if (heal.commit !== null || heal.changed) return "fix-pushed";

  return "nothing-to-fix";
};

/**
 * Where a failed run stands once its heal has ended as `result`. A heal that
 * found nothing to fix, or broke, leaves the failure with nothing healing it.
 */
export const failureAfter = (result: HealResult): Domain.RunState => {
  switch (result) {
    case "retried":
      return "retrying";
    case "nothing-to-fix":
      return "failed";
    default:
      return result;
  }
};

/**
 * The states a later run passing ends in, as a settled failure's own: one
 * that did its work, or found none to do, such as a machine job with nothing
 * to update. A run that handed off may have handed off the very thing that
 * failed, so it settles failures only through the heals and waiting heals it
 * reached.
 */
export const passing: ReadonlyArray<Domain.RunState> = ["succeeded", "skipped"];

/** A run as the backfill reads it, from the columns that existed then. */
export interface Row {
  readonly id: string;
  readonly job: string;
  readonly state: Domain.RunState;
  readonly scopeRepo: string | null;
  readonly releaseRepo: string | null;
  readonly command: string | null;
  readonly queuedAt: number;
  readonly attention: boolean;
  readonly changed: boolean;
  readonly healOf: string | null;
  readonly healDecision: Domain.HealDecision | null;
  readonly healActions: ReadonlyArray<string>;
  readonly healCommit: string | null;
  readonly healSession: string | null;
}

/** What the backfill sets on a run. */
export interface Filled {
  readonly id: string;
  readonly state: Domain.RunState;
  readonly heals: ReadonlyArray<string>;
  readonly retry: string | null;
  readonly retryOf: string | null;
  readonly settledBy: string | null;
}

const lower = (value: string | null) => value?.toLowerCase() ?? null;

/**
 * Whether `later`, a run that passed, settles `failed`: the same job and
 * command, for the same released repository, covering its repository.
 */
export const settles = (
  later: Pick<Row, "job" | "scopeRepo" | "releaseRepo" | "command">,
  failed: Pick<Row, "job" | "scopeRepo" | "releaseRepo" | "command">,
) =>
  later.job === failed.job &&
  later.command === failed.command &&
  lower(later.releaseRepo) === lower(failed.releaseRepo) &&
  (later.scopeRepo === null ||
    lower(later.scopeRepo) === lower(failed.scopeRepo));

const before = (a: Row, b: Row) =>
  a.queuedAt < b.queuedAt || (a.queuedAt === b.queuedAt && a.id < b.id);

/**
 * Fill in the states and links of runs from before them: each heal run's
 * result and retry, and each failed run's heals, retry and where it stands,
 * settled by the first later run that passed. `waiting` holds the failed runs
 * a heal is waiting for. Returns only the runs that change.
 */
export const backfill = (
  rows: ReadonlyArray<Row>,
  waiting: ReadonlySet<string>,
): ReadonlyArray<Filled> => {
  const ordered = rows.toSorted((a, b) => (before(a, b) ? -1 : 1));
  const ids = new Set(ordered.map(({ id }) => id));

  const filled = new Map<string, Filled>(
    ordered.map((row) => [
      row.id,
      {
        id: row.id,
        state: row.state,
        heals: [],
        retry: null,
        retryOf: null,
        settledBy: null,
      },
    ]),
  );

  const set = (id: string, change: Partial<Filled>) => {
    const current = filled.get(id);

    if (current !== undefined) filled.set(id, { ...current, ...change });
  };

  for (const row of ordered) {
    if (row.healOf === null) continue;

    const of = filled.get(row.healOf);

    if (of !== undefined) set(of.id, { heals: [...of.heals, row.id] });

    if (row.state !== "succeeded" && row.state !== "failed") continue;

    const found = retryOf(row.healActions);
    const retry = found !== null && ids.has(found) ? found : null;

    if (retry !== null) {
      set(row.id, { retry });
      set(retry, { retryOf: row.healOf });
      set(row.healOf, { retry });
    }

    set(row.id, {
      state: healResult(
        {
          attention: row.attention,
          decision: row.healDecision,
          actions: row.healActions,
          commit: row.healCommit,
          retry,
          changed: row.changed,
        },
        row.state === "failed",
      ),
    });
  }

  for (const [index, row] of ordered.entries()) {
    if (row.healOf !== null || row.state !== "failed") continue;

    const own = filled.get(row.id);

    if (own === undefined) continue;

    const settledBy = ordered
      .slice(index + 1)
      .find((later) => passing.includes(later.state) && settles(later, row));

    if (settledBy !== undefined) {
      set(row.id, {
        state: own.heals.length > 0 ? "healed" : "recovered",
        settledBy: settledBy.id,
      });

      continue;
    }

    const last = own.heals.at(-1);
    const heal = last === undefined ? undefined : filled.get(last);

    if (heal !== undefined) {
      const session =
        ordered.find(({ id }) => id === heal.id)?.healSession ?? null;

      set(row.id, {
        state: isHealResult(heal.state)
          ? failureAfter(heal.state)
          : heal.state === "running" && session !== null
            ? "with-agent"
            : heal.state === "cancelled"
              ? "failed"
              : "healing",
      });

      continue;
    }

    if (waiting.has(row.id)) set(row.id, { state: "heal-waiting" });
    else if (row.attention) set(row.id, { state: "needs-you" });
  }

  const unchanged = (row: Row, fill: Filled) =>
    fill.state === row.state &&
    fill.heals.length === 0 &&
    fill.retry === null &&
    fill.retryOf === null &&
    fill.settledBy === null;

  return ordered.flatMap((row) => {
    const fill = filled.get(row.id);

    return fill === undefined || unchanged(row, fill) ? [] : [fill];
  });
};
