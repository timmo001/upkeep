/**
 * The jobs Upkeep runs, behind one service so the CLI, its Code Mode
 * manifest and the MCP server read the same list.
 */
import { Catalogue, Domain } from "@upkeep/api";
import { Context, Effect, Layer, Schema } from "effect";

export const Job = Domain.Job;

export type Job = Domain.Job;

export class JobsError extends Schema.TaggedError<JobsError>()("JobsError", {
  message: Schema.String,
}) {}

export class Jobs extends Context.Service<
  Jobs,
  {
    readonly list: () => Effect.Effect<readonly Job[], JobsError>;
  }
>()("@upkeep/cli/Jobs") {
  /** The jobs in the shared catalogue, which the server schedules. */
  static readonly catalogue = Layer.succeed(
    Jobs,
    Jobs.of({ list: () => Effect.succeed(Catalogue.jobs) }),
  );
}
