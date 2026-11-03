/**
 * The jobs the worker runs, behind one service so the CLI, its Code Mode
 * manifest and the MCP server read the same list. None are built yet, so the
 * only layer is empty until the first job lands.
 */
import { Context, Effect, Layer, Schema } from "effect";

export const Job = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
});

export interface Job extends Schema.Schema.Type<typeof Job> {}

export class JobsError extends Schema.TaggedError<JobsError>()("JobsError", {
  message: Schema.String,
}) {}

export class Jobs extends Context.Service<
  Jobs,
  {
    readonly list: () => Effect.Effect<readonly Job[], JobsError>;
  }
>()("@upkeep/cli/Jobs") {
  static readonly empty = Layer.succeed(
    Jobs,
    Jobs.of({ list: () => Effect.succeed([]) }),
  );
}
