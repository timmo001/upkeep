/**
 * Where a job sends what it found and what it did: to the server for a run a
 * worker took, so it can queue the jobs that follow and keep a heal's record,
 * or nowhere for one run by hand with `upkeep run --local`.
 */
import { Api, Client, Domain } from "@upkeep/api";
import { Array as Arr, Context, Effect, Layer } from "effect";
import * as RunLog from "./RunLog";

export class Reporter extends Context.Service<
  Reporter,
  {
    /** The latest release of each repository. Returns the runs it queued. */
    readonly releases: (
      releases: ReadonlyArray<Domain.Release>,
    ) => Effect.Effect<ReadonlyArray<Domain.Run>, unknown>;
    /**
     * For a heal: its record, the run it heals with the end of its log, and
     * what triage knows of failures like it.
     */
    readonly healing: () => Effect.Effect<Healing, unknown>;
    /** For a heal: queue the failed job again, unless it's parked. */
    readonly retry: () => Effect.Effect<Domain.Run | null, unknown>;
    /**
     * Park a job until someone unparks it, or until `issue`, its triage
     * issue, is resolved.
     */
    readonly park: (
      job: string,
      reason: string,
      issue: string | null,
    ) => Effect.Effect<void, unknown>;
    /** For a heal: fill in its record. */
    readonly heal: (update: Api.HealUpdate) => Effect.Effect<void, unknown>;
    /** The heals queued since `since`, newest first. */
    readonly heals: (
      since: number,
    ) => Effect.Effect<ReadonlyArray<Domain.Run>, unknown>;
  }
>()("@upkeep/worker/Reporter") {
  /** Send findings to the server, for the run `runId`. */
  static readonly remote = (runId: string) =>
    Layer.effect(
      Reporter,
      Effect.gen(function* () {
        const client = yield* Client;
        const params = { id: runId };

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
          healing: () => client.work.healing({ params }),
          retry: () =>
            client.work.retry({ params }).pipe(Effect.map(({ run }) => run)),
          park: (job, reason, issue) =>
            client.work.park({
              params: { job },
              payload: issue === null ? { reason } : { reason, issue },
            }),
          heal: (update) => client.work.heal({ params, payload: update }),
          heals: (since) => client.work.heals({ query: { since } }),
        });
      }),
    );

  /**
   * Queue and park nothing, for a run that only shows what it would do. A
   * heal needs the server's run, so it can't run here.
   */
  static readonly local = Layer.succeed(
    Reporter,
    Reporter.of({
      releases: () => Effect.succeed([]),
      healing: () => Effect.fail("A heal only runs on a worker"),
      retry: () => Effect.succeed(null),
      park: (job, reason) =>
        RunLog.info(`Would park ${job}: ${reason}`).pipe(
          Effect.provide(RunLog.RunLog.console),
        ),
      heal: () => Effect.void,
      heals: () => Effect.succeed([]),
    }),
  );
}

export interface Healing {
  readonly heal: Domain.Heal;
  readonly run: Domain.Run;
  readonly log: ReadonlyArray<Domain.LogLine>;
  readonly precedents: ReadonlyArray<Domain.Precedent>;
}
