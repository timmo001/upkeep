/**
 * The worker's own status, written to a JSON file whenever it changes, so a
 * service monitor such as dot's services panel can show what the worker is
 * doing rather than only that its process is up. The file holds `health`,
 * `summary` and `updated`, the shape dot reads from a service's status file.
 */
import { Clock, Config, Effect, FileSystem, Path, Semaphore } from "effect";

export interface State {
  /** The jobs running now, one per lane. */
  readonly running: ReadonlyArray<string>;
  /** How the last run ended, such as `bump succeeded`. */
  readonly last: { readonly job: string; readonly failed: boolean } | null;
  /** Whether the server answered the last time the worker asked. */
  readonly reachable: boolean;
  readonly parked: ReadonlyArray<string>;
  /** Heals in the last day that were left for a person. */
  readonly asking: number;
  /** Commands the settings need that aren't on the worker's PATH. */
  readonly missing: ReadonlyArray<string>;
  /** Whether it's the worker's quiet hours, when it takes no new runs. */
  readonly quiet: boolean;
}

export const initial: State = {
  running: [],
  last: null,
  reachable: true,
  parked: [],
  asking: 0,
  missing: [],
  quiet: false,
};

/** The status a monitor reads: its health and one line saying why. */
export const report = (state: State) => {
  const parts = [
    state.reachable
      ? state.running.length > 0
        ? `Running ${state.running.join(", ")}`
        : state.quiet
          ? "Quiet hours"
          : "Waiting for runs"
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
    ...(state.missing.length === 0
      ? []
      : [`${state.missing.join(", ")} not on PATH`]),
  ];

  // Parked jobs, asking heals and failed runs are the dashboard's to show;
  // the worker itself is only unwell when it can't reach the server, or
  // can't find a command its heals need.
  const health: "ok" | "warning" | "degraded" = !state.reachable
    ? "degraded"
    : state.missing.length > 0
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
  // Lanes update the status concurrently, so writes take turns on the file
  const writing = yield* Semaphore.make(1);

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
    (effect) => writing.withPermit(effect),
    Effect.catchCause((cause) =>
      Effect.logWarning("Couldn't write the worker status", cause),
    ),
  );

  const update = (change: (current: State) => Partial<State>) =>
    Effect.suspend(() => {
      const next = { ...state, ...change(state) };
      const same = JSON.stringify(next) === JSON.stringify(state);

      state = next;

      return same ? Effect.void : write;
    });

  return {
    update: (change: Partial<State>) => update(() => change),
    /** Note a run started in one lane. */
    started: (job: string) =>
      update((current) => ({ running: [...current.running, job] })),
    /** Note a run ended in one lane, and how. */
    finished: (job: string, failed: boolean) =>
      update((current) => {
        const index = current.running.indexOf(job);

        return {
          running: current.running.filter((_, at) => at !== index),
          last: { job, failed },
        };
      }),
    write,
  };
});
