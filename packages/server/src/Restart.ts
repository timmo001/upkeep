/**
 * Restarting the server in its own process, such as to finish a restore:
 * `Server.run` stops everything, then starts it again.
 */
import { Context, type Effect } from "effect";

export class Restart extends Context.Service<
  Restart,
  {
    /** Restart the server shortly; it returns at once. */
    readonly request: Effect.Effect<void>;
  }
>()("@upkeep/server/Restart") {}
