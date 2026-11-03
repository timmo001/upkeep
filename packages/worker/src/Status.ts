/**
 * The worker's own status, written to a JSON file whenever it changes, so a
 * service monitor such as dot's services panel can show what the worker is
 * doing rather than only that its process is up. The file holds `health`,
 * `summary` and `updated`, the shape dot reads from a service's status file.
 */
import { Clock, Config, Effect, FileSystem, Path } from "effect";

export interface State {
  /** The job running now, if any. */
  readonly running: string | null;
  /** How the last run ended, such as `bump succeeded`. */
  readonly last: { readonly job: string; readonly failed: boolean } | null;
  /** Whether the server answered the last time the worker asked. */
  readonly reachable: boolean;
  readonly parked: ReadonlyArray<string>;
  /** Heals in the last day that were left for a person. */
  readonly asking: number;
}

export const initial: State = {
  running: null,
  last: null,
  reachable: true,
  parked: [],
  asking: 0,
};

/** The status a monitor reads: its health and one line saying why. */
export const report = (state: State) => {
  const parts = [
    state.reachable
      ? state.running === null
        ? "Waiting for runs"
        : `Running ${state.running}`
      : "Can't reach the server",
    ...(state.last === null
      ? []
      : [
          `last ${state.last.job} ${state.last.failed ? "failed" : "succeeded"}`,
        ]),
    ...(state.parked.length === 0
      ? []
      : [`parked: ${state.parked.join(", ")}`]),
    ...(state.asking === 0
      ? []
      : [`${state.asking} heal${state.asking === 1 ? "" : "s"} asking`]),
  ];

  const health: "ok" | "warning" | "degraded" = !state.reachable
    ? "degraded"
    : state.parked.length > 0 || state.asking > 0 || state.last?.failed
      ? "warning"
      : "ok";

  return { health, summary: parts.join(" · ") };
};

/**
 * Where the status goes: `$UPKEEP_WORKER_STATUS`, or `worker-status.json` in
 * `$XDG_STATE_HOME/upkeep`.
 */
const file = Effect.gen(function* () {
  const path = yield* Path.Path;
  const home = yield* Config.String("HOME").pipe(Config.withDefault(""));

  const stateHome = yield* Config.String("XDG_STATE_HOME").pipe(
    Config.withDefault(path.join(home, ".local", "state")),
  );

  return yield* Config.String("UPKEEP_WORKER_STATUS").pipe(
    Config.withDefault(path.join(stateHome, "upkeep", "worker-status.json")),
  );
});

/**
 * A writer that keeps the state and replaces the file atomically on each
 * change. A file that can't be written is logged and the worker carries on.
 */
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* file;
  let state = initial;

  const write = Effect.gen(function* () {
    const updated = yield* Clock.currentTimeMillis;
    const temporary = `${target}.tmp`;

    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(
      temporary,
      `${JSON.stringify({ ...report(state), updated })}\n`,
    );
    yield* fs.rename(temporary, target);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Couldn't write the worker status", cause),
    ),
  );

  return {
    update: (change: Partial<State>) =>
      Effect.suspend(() => {
        const next = { ...state, ...change };
        const same = JSON.stringify(next) === JSON.stringify(state);

        state = next;

        return same ? Effect.void : write;
      }),
    write,
  };
});
