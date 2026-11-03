/**
 * Where a job sends what it found: to the server for a run a worker took, so
 * it can queue the jobs that follow, or nowhere for one run by hand with
 * `upkeep run --local`.
 */
import { Api, Client, Domain } from "@upkeep/api";
import { Array as Arr, Context, Effect, Layer } from "effect";

export class Reporter extends Context.Service<
  Reporter,
  {
    /** The latest release of each repository. Returns the runs it queued. */
    readonly releases: (
      releases: ReadonlyArray<Domain.Release>,
    ) => Effect.Effect<ReadonlyArray<Domain.Run>, unknown>;
  }
>()("@upkeep/worker/Reporter") {
  /** Send findings to the server. */
  static readonly remote = Layer.effect(
    Reporter,
    Effect.gen(function* () {
      const client = yield* Client;

      return Reporter.of({
        releases: Effect.fnUntraced(function* (releases) {
          const queued: Array<Domain.Run> = [];

          for (const batch of Arr.chunksOf(releases, Api.maxReleases)) {
            const result = yield* client.work.releases({
              payload: { releases: batch },
            });

            queued.push(...result.queued);
          }

          return queued;
        }),
      });
    }),
  );

  /** Queue nothing, for a run that only shows what it would find. */
  static readonly local = Layer.succeed(
    Reporter,
    Reporter.of({ releases: () => Effect.succeed([]) }),
  );
}
