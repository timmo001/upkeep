/**
 * Freeing a run's lane before the run ends. A run that hands its work to an
 * agent and only waits on it, such as a change or a skill change, frees its
 * lane once the agent is going, so the next run in the lane starts while it
 * waits. Only the lanes that allow it set this; elsewhere it does nothing.
 */
import { Context, Effect } from "effect";

/** What frees the current run's lane, nothing outside the lanes that allow it. */
export const Release = Context.Reference<Effect.Effect<void>>(
  "@upkeep/worker/Lane/Release",
  { defaultValue: () => Effect.void },
);

/** Free the current run's lane, where its lane allows it. */
export const release = Effect.flatMap(Release, (free) => free);
