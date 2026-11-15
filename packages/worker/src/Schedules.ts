/**
 * OpenCode schedules on the agent sessions Upkeep starts. When an agent
 * stops while a part of GitHub its work needs is down, the worker schedules
 * a prompt in its session that checks the part every few minutes, with the
 * same read a run does, and wakes the session to carry on once it answers,
 * so the agent picks up in the same context rather than waiting for you.
 * Every few minutes, and straight after a change, the worker tells the server
 * what's scheduled on the sessions its agents ran in, for the dashboard to
 * show, and it pauses, resumes, deletes and adds them when you ask there.
 * Schedules are experimental in OpenCode: without `experimental.schedules`
 * on, creating one fails and the session is left for you as before.
 */
import { Client, type Domain } from "@upkeep/api";
import { Config, Effect, Match, Option, Ref, Schedule, Schema } from "effect";
import { reason } from "./Failure";
import * as Outages from "./Outages";
import { summary } from "./Reporter";
import * as RunLog from "./RunLog";
import * as Settings from "./settings";
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

/** A schedule as OpenCode lists it, with only what Upkeep shows. */
const Info = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  when: Schema.Union([
    Schema.Struct({ type: Schema.Literal("in"), in: Schema.String }),
    Schema.Struct({ type: Schema.Literal("at"), at: Schema.String }),
    Schema.Struct({ type: Schema.Literal("every"), every: Schema.String }),
    Schema.Struct({ type: Schema.Literal("cron"), cron: Schema.String }),
  ]),
  if: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("shell"), run: Schema.String }),
      Schema.Struct({ type: Schema.Literal("code") }),
    ]),
  ),
  action: Schema.Struct({ prompt: Schema.String }),
  status: Schema.Literals(["active", "paused", "done"]),
  nextDueAt: Schema.optionalKey(Schema.Finite),
  endsAt: Schema.optionalKey(Schema.Finite),
  runCount: Schema.Number,
  lastFiredAt: Schema.optionalKey(Schema.Finite),
  lastOutcome: Schema.optionalKey(Schema.String),
});

const Listed = Schema.fromJsonString(
  Schema.Struct({ data: Schema.Array(Info) }),
);

const whenOf = (when: typeof Info.Type.when) =>
  Match.value(when).pipe(
    Match.discriminatorsExhaustive("type")({
      in: (at) => `in ${at.in}`,
      at: (at) => `at ${at.at}`,
      every: (at) => `every ${at.every}`,
      cron: (at) => `cron ${at.cron}`,
    }),
  );

/** The schedules on `session`, as the server shows them. */
export const list = Effect.fnUntraced(function* (
  opencode: string,
  session: string,
  options: Options,
) {
  const { data } = yield* run(
    opencode,
    ["api", "get", `/api/experimental/schedule?sessionID=${session}`],
    options,
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Listed)));

  return data.map((info): Domain.SessionSchedule => ({
    id: info.id,
    session,
    name: info.name ?? null,
    when: whenOf(info.when),
    condition:
      info.if === undefined
        ? null
        : info.if.type === "shell"
          ? info.if.run
          : "a code check",
    prompt: info.action.prompt,
    status: info.status,
    nextDueAt: info.nextDueAt ?? null,
    endsAt: info.endsAt ?? null,
    runCount: info.runCount,
    lastFiredAt: info.lastFiredAt ?? null,
    lastOutcome: info.lastOutcome ?? null,
  }));
});

/** The OpenCode command and a directory to run it in, from the settings. */
const opencodeHere = Effect.gen(function* () {
  const settings = yield* Settings.load();
  const home = yield* Config.String("HOME").pipe(Config.withDefault(""));

  return {
    opencode: settings.heal?.opencode ?? "opencode2",
    options: { cwd: home, trusted: "" },
  };
});

/**
 * Every schedule on the sessions the server says this worker's agents ran
 * in. A session OpenCode here no longer has shows none.
 */
const gather = Effect.gen(function* () {
  const client = yield* Client;
  const { opencode, options } = yield* opencodeHere;
  const sessions = yield* client.work.sessions();

  const found = yield* Effect.forEach(
    sessions,
    ({ session }) => list(opencode, session, options),
    { concurrency: 4 },
  );

  return found.flat();
});

/**
 * Tell the server what's scheduled now, such as straight after a change.
 * A run with no server to report to, such as a local one, skips it.
 */
export const report = Effect.gen(function* () {
  const client = yield* Effect.serviceOption(Client);

  if (Option.isNone(client)) return;

  const schedules = yield* gather.pipe(
    Effect.provideService(Client, client.value),
  );

  yield* client.value.work.putSchedules({ payload: { schedules } });
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logDebug("Couldn't report the agents' schedules", cause),
  ),
);

/**
 * Tell the server about the schedules on this worker's agents' sessions every
 * few minutes until the worker stops, when they've changed.
 */
export const follow = Effect.gen(function* () {
  const client = yield* Client;

  // The schedules the server last took, so an unchanged set isn't sent again
  const sent = yield* Ref.make(Option.none<string>());

  const check = Effect.gen(function* () {
    const schedules = yield* gather;
    const key = JSON.stringify(schedules);

    if (Option.contains(yield* Ref.get(sent), key)) return;

    yield* client.work.putSchedules({ payload: { schedules } });
    yield* Ref.set(sent, Option.some(key));
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logDebug("Couldn't check the agents' schedules", cause),
    ),
  );

  yield* check.pipe(Effect.repeat(Schedule.spaced(checkEvery)));
});

/** What a schedule command did, for the run's summary. */
const done = new Map([
  ["schedule-pause", "Paused"],
  ["schedule-resume", "Resumed"],
  ["schedule-delete", "Deleted"],
]);

/** A schedule command: change a schedule on a session here, then report. */
export const change = Effect.fnUntraced(function* (
  command: Extract<
    Domain.Command,
    {
      readonly kind:
        | "schedule-pause"
        | "schedule-resume"
        | "schedule-delete"
        | "schedule-add";
    }
  >,
) {
  const { opencode, options } = yield* opencodeHere;
  const path = "/api/experimental/schedule";

  if (command.kind === "schedule-add") {
    const payload = {
      sessionID: command.session,
      ...(command.name !== undefined && { name: command.name }),
      when: command.when,
      ...(command.condition !== undefined && {
        if: { run: command.condition },
      }),
      prompt: command.prompt,
    };

    const { data } = yield* run(
      opencode,
      ["api", "post", path, "--data", JSON.stringify(payload)],
      options,
    ).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Created)),
      ),
    );

    yield* summary(`Scheduled ${data.id} in session ${command.session}`);
  } else {
    const [method, endpoint] =
      command.kind === "schedule-delete"
        ? ["delete", `${path}/${command.schedule}`]
        : [
            "post",
            `${path}/${command.schedule}/${command.kind === "schedule-pause" ? "pause" : "resume"}`,
          ];

    yield* run(opencode, ["api", method, endpoint], options);
    yield* summary(
      `${done.get(command.kind) ?? "Changed"} ${command.schedule} in session ${command.session}`,
    );
  }

  yield* report;
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
    Effect.tap(() => report),
    Effect.catchCause((cause) =>
      RunLog.warn(
        `GitHub's ${name} is down, but the session couldn't be scheduled to wake once it's back: ${reason(cause)}`,
      ).pipe(Effect.as(Option.none<string>())),
    ),
  );
});
