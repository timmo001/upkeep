/**
 * GitHub's rate limits, which Upkeep shares with everything else signed in as
 * the same account, such as Actions workflows that use a personal token. New
 * runs wait while a limit is down to its reserve, so Upkeep never spends the
 * last of it, and runs, heals and CI watches wait for a spent limit to reset
 * rather than failing on it.
 */
import { isRateLimited, RateLimit, type GhError } from "@timmo001/effect-gh";
import { Clock, Duration, Effect, Option } from "effect";
import * as RunLog from "./RunLog";

/** The longest anything waits for a limit to reset. */
export const maxWait = Duration.hours(1);

/**
 * The share of each limit kept for everything else on the account: no new
 * run starts once this little is left, until the limit resets.
 */
export const reserve = 0.1;

/** A limit that's down to its floor, with its reset in epoch milliseconds. */
export interface Low {
  readonly resource: "core" | "graphql";
  readonly remaining: number;
  readonly limit: number;
  readonly reset: number;
}

/**
 * The core or GraphQL limit with no more than `share` of it left, the one
 * that resets last when both are. Reading the limits doesn't count against
 * them, and one that can't be read counts as fine.
 */
const below = Effect.fnUntraced(function* (share: number) {
  const limits = yield* Effect.forEach(
    ["core", "graphql"] as const,
    (resource) =>
      RateLimit.get(resource).pipe(
        Effect.map(({ remaining, limit, reset }): Low => ({
          resource,
          remaining,
          limit,
          reset: reset * 1000,
        })),
        Effect.option,
      ),
  );

  const now = yield* Clock.currentTimeMillis;

  return Option.fromUndefinedOr(
    limits
      .flatMap((limit) => (Option.isSome(limit) ? [limit.value] : []))
      .filter(
        ({ remaining, limit, reset }) =>
          remaining <= Math.floor(limit * share) && reset > now,
      )
      .toSorted((a, b) => b.reset - a.reset)[0],
  );
});

/** The limit that's down to its {@link reserve}, if one is. */
export const low = () => below(reserve);

/** When the spent core or GraphQL limit resets, if one is spent. */
export const spentUntil = () =>
  below(0).pipe(Effect.map(Option.map(({ reset }) => reset)));

/** How long to wait for a reset, with a few seconds' grace, capped. */
export const waitUntil = (reset: number, now: number) =>
  Duration.min(Duration.seconds(Math.ceil((reset - now) / 1000) + 5), maxWait);

/** The time of day a limit resets, in UTC, for the log. */
export const at = (reset: number) =>
  `${new Date(reset).toISOString().slice(11, 16)} UTC`;

/** How many times {@link waitOut} waits before letting the failure through. */
const waits = 3;

/**
 * Run a GitHub read again once the limit it hit resets, or after a minute for
 * a secondary limit, which has no reset to wait for. Only for reads, since a
 * write can land even when it reports a failure.
 */
export const waitOut = <A, E extends GhError, R>(
  effect: Effect.Effect<A, E, R>,
  what: string,
) => {
  const attempt = (
    tries: number,
  ): Effect.Effect<
    A,
    E,
    R | Effect.Services<ReturnType<typeof spentUntil>> | RunLog.RunLog
  > =>
    effect.pipe(
      Effect.catch((error) =>
        tries >= waits || !isRateLimited(error)
          ? Effect.fail(error)
          : Effect.gen(function* () {
              const reset = yield* spentUntil();
              const now = yield* Clock.currentTimeMillis;

              const delay = Option.match(reset, {
                onNone: () => Duration.minutes(1),
                onSome: (time) => waitUntil(time, now),
              });

              yield* RunLog.warn(
                `${what}: GitHub's rate limit is spent, so waiting ${Duration.format(delay)}${Option.match(reset, { onNone: () => "", onSome: (time) => ` for its reset at ${at(time)}` })}`,
              );
              yield* Effect.sleep(delay);

              return yield* attempt(tries + 1);
            }),
      ),
    );

  return attempt(0);
};
