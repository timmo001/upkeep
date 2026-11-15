/**
 * OpenCode schedules on the agent sessions Upkeep starts. When an agent
 * stops while a part of GitHub its work needs is down, the worker schedules
 * a prompt in its session that checks the part every few minutes, with the
 * same read a run does, and wakes the session to carry on once it answers,
 * so the agent picks up in the same context rather than waiting for you.
 * Schedules are experimental in OpenCode: without `experimental.schedules`
 * on, creating one fails and the session is left for you as before.
 */
import { Effect, Option, Schema } from "effect";
import { reason } from "./Failure";
import * as Outages from "./Outages";
import * as RunLog from "./RunLog";
import { run } from "./jobs/bump";

/** How often a wake-up checks GitHub again. */
export const checkEvery = "5 minutes";

/** How long a wake-up waits for GitHub before it gives up. */
export const waitFor = "2 hours";

/** The parts of GitHub an agent's work uses: pushing, its reads and CI. */
export const agentParts: ReadonlyArray<Outages.Part> = [
  "git",
  "rest",
  "graphql",
  "pulls",
  "actions",
];

const Created = Schema.Struct({
  data: Schema.Struct({ id: Schema.String }),
});

type Options = { readonly cwd: string; readonly trusted: string };

/**
 * Schedule a wake-up in `session` for the first of `parts` that's down, if
 * any is. Returns the schedule's ID, or none when GitHub is up or OpenCode
 * couldn't schedule it, which is logged.
 */
export const wakeWhenBack = Effect.fnUntraced(function* (
  opencode: string,
  session: string,
  parts: ReadonlyArray<Outages.Part>,
  options: Options,
) {
  const found = yield* Outages.down(parts);

  if (Option.isNone(found)) return Option.none<string>();

  const part = found.value;
  const name = Outages.names[part];

  const payload = {
    sessionID: session,
    name: `Wait for GitHub's ${name}`,
    when: { every: checkEvery },
    if: { run: `upkeep github check ${part}` },
    ends: { after: waitFor, times: 1 },
    prompt: `GitHub's ${name} is back. Carry on where you left off.`,
  };

  return yield* run(
    opencode,
    [
      "api",
      "post",
      "/api/experimental/schedule",
      "--data",
      JSON.stringify(payload),
    ],
    options,
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Created))),
    Effect.map(({ data }) => Option.some(data.id)),
    Effect.tap((id) =>
      RunLog.info(
        `GitHub's ${name} is down, so the session wakes to carry on once it's back, checked every ${checkEvery} for up to ${waitFor} (schedule ${Option.getOrElse(id, () => "")})`,
      ),
    ),
    Effect.catchCause((cause) =>
      RunLog.warn(
        `GitHub's ${name} is down, but the session couldn't be scheduled to wake once it's back: ${reason(cause)}`,
      ).pipe(Effect.as(Option.none<string>())),
    ),
  );
});
