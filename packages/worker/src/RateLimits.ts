/**
 * GitHub's rate limits, which Upkeep shares with everything else signed in as
 * the same account. Runs, heals and CI watches wait for a spent limit to reset
 * rather than failing on it.
 */
import { isRateLimited, RateLimit, type GhError } from "@timmo001/effect-gh";
import { Clock, Duration, Effect, Option } from "effect";
import * as RunLog from "./RunLog";

/** The longest anything waits for a limit to reset. */
export const maxWait = Duration.hours(1);

/**
 * When the spent core or GraphQL limit resets, in epoch milliseconds, if one
 * is spent. Reading the limits doesn't count against them.
 */
export const spentUntil = Effect.fnUntraced(function* () {
  const limits = yield* Effect.forEach(
    ["core", "graphql"] as const,
    (resource) => RateLimit.get(resource).pipe(Effect.option),
  );

  const now = yield* Clock.currentTimeMillis;

  const reset = Math.max(
    ...limits.flatMap((limit) =>
      Option.isSome(limit) && limit.value.remaining === 0
        ? [limit.value.reset * 1000]
        : [],
    ),
    0,
  );

  return reset > now ? Option.some(reset) : Option.none<number>();
});

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
