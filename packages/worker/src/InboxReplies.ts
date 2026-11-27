/**
 * Brings heal agents back when you answer them in the Plannotator Inbox. A
 * heal's agent runs headless and ends with its turn, so when it asks you
 * something in the Inbox, your answer finds no live session to wake and
 * waits there. Once a minute the worker reads the Inbox threads of each heal
 * that's left for you and whose session worked on this machine, and when you
 * replied since, it resumes the session in the background in the heal's
 * worktree, telling the agent to read your answer and carry on.
 */
import { Client, type Domain } from "@upkeep/api";
import {
  Clock,
  Effect,
  FileSystem,
  Option,
  Ref,
  Schedule,
  Schema,
} from "effect";
import { reason } from "./Failure";
import { run } from "./jobs/bump";
import * as Settings from "./settings";

/** How far back heals left for you are looked at. */
const lookBackMillis = 14 * 24 * 60 * 60 * 1000;

/** A session's Inbox threads, as `plannotator inbox call read_thread` lists them. */
const Threads = Schema.fromJsonString(
  Schema.Struct({
    threads: Schema.Array(
      Schema.Struct({
        thread_id: Schema.String,
        unread: Schema.optionalKey(Schema.Boolean),
        last_person_message_id: Schema.optionalKey(
          Schema.NullOr(Schema.String),
        ),
      }),
    ),
  }),
);

/** What the agent is told when it's resumed for your answer. */
const resumePrompt = (run: string) =>
  [
    "The person has answered you in the Plannotator Inbox. Your session had ended, so Upkeep resumed it for you to carry on.",
    "Load the `plannotator` skill, list your threads with the `plannotator_inbox` tool's read_thread, and read each one marked unread for their reply.",
    "Your checkout may be behind: fetch origin and check its default branch before you change anything.",
    "Then do what they decided, running the repository's checks and pushing as the work asked, and reply in the same thread with what you did. Ask there again if you still need something only they can decide, and end your turn.",
    `Upkeep shows run ${run} as needing them until it's dismissed. Once the work is done and nothing waits on them any more, dismiss it with Upkeep's \`dismiss\` tool or \`upkeep dismiss ${run}\`, and say so in the thread.`,
  ].join(" ");

/** A heal left for you whose session worked here, in a worktree still here. */
const waitingHere = Effect.fnUntraced(function* (
  heals: ReadonlyArray<Domain.Run>,
) {
  const fs = yield* FileSystem.FileSystem;

  const candidates = heals.flatMap((heal) =>
    heal.attention &&
    heal.finishedAt !== null &&
    heal.heal?.session !== null &&
    heal.heal?.session !== undefined &&
    heal.heal.directory !== null
      ? [
          {
            run: heal.id,
            session: heal.heal.session,
            directory: heal.heal.directory,
          },
        ]
      : [],
  );

  // A session healed twice shows once, with its newest heal
  const latest = new Map(
    candidates
      .toReversed()
      .map((waiting) => [waiting.session, waiting] as const),
  );

  return yield* Effect.filter(
    [...latest.values()],
    ({ directory }) =>
      fs.exists(directory).pipe(Effect.orElseSucceed(() => false)),
    { concurrency: 4 },
  );
});

/**
 * Your latest reply the session hasn't read, as its message ID, or none.
 * The Inbox files threads by project, found from the heal's worktree.
 */
const unreadReply = Effect.fnUntraced(function* (
  session: string,
  directory: string,
) {
  const listed = yield* run(
    "plannotator",
    [
      "inbox",
      "call",
      "--session",
      session,
      "read_thread",
      JSON.stringify({ project_path: directory }),
    ],
    { cwd: directory, trusted: "" },
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Threads)));

  const replies = listed.threads.flatMap((thread) =>
    thread.unread === true &&
    thread.last_person_message_id !== null &&
    thread.last_person_message_id !== undefined
      ? [thread.last_person_message_id]
      : [],
  );

  // Message IDs sort by time, so the newest is the last
  return Option.fromNullishOr(replies.toSorted().at(-1));
});

/**
 * Follow the Inbox for replies to heals left for you, resuming each session
 * once for each reply, until the worker stops.
 */
export const follow = Effect.gen(function* () {
  const client = yield* Client;

  // The reply each session was last resumed for, so it's resumed once per
  // reply even when the agent doesn't read it, and the sessions running now
  const handled = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const running = yield* Ref.make<ReadonlySet<string>>(new Set());

  const resume = Effect.fnUntraced(function* (
    waiting: { run: string; session: string; directory: string },
    reply: string,
  ) {
    const settings = (yield* Settings.load()).heal ?? {};
    const opencode = settings.opencode ?? "opencode2";
    const minutes = settings.sessionMinutes ?? 30;

    yield* Effect.logInfo(
      `You replied in the Inbox to heal ${waiting.run}: resuming session ${waiting.session} in ${waiting.directory}`,
    );

    yield* run(
      opencode,
      // Nobody is there to answer a permission prompt; denied ones stay denied
      [
        "run",
        "--auto",
        "--session",
        waiting.session,
        resumePrompt(waiting.run),
      ],
      { cwd: waiting.directory, trusted: "" },
    ).pipe(
      Effect.timeout(`${minutes} minutes`),
      Effect.tap(() =>
        Effect.logInfo(
          `Session ${waiting.session} finished with your reply ${reply}`,
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Session ${waiting.session} stopped with your reply ${reply}: ${reason(cause)}`,
        ),
      ),
      Effect.ensuring(
        Ref.update(running, (sessions) => {
          const left = new Set(sessions);

          left.delete(waiting.session);

          return left;
        }),
      ),
    );
  });

  const check = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const heals = yield* client.work.heals({
      query: { since: now - lookBackMillis },
    });

    for (const waiting of yield* waitingHere(heals)) {
      if ((yield* Ref.get(running)).has(waiting.session)) continue;

      const reply = yield* unreadReply(waiting.session, waiting.directory).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug(
            `Couldn't read the Inbox for session ${waiting.session}`,
            cause,
          ).pipe(Effect.as(Option.none<string>())),
        ),
      );

      // Each reply resumes the session once, even when the agent doesn't read it
      const seen = (yield* Ref.get(handled)).get(waiting.session);

      if (Option.isNone(reply) || seen === reply.value) continue;

      yield* Ref.update(handled, (before) =>
        new Map(before).set(waiting.session, reply.value),
      );
      yield* Ref.update(running, (before) =>
        new Set(before).add(waiting.session),
      );

      // The agent can take its whole time limit, so it runs beside the checks
      yield* Effect.forkScoped(resume(waiting, reply.value));
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logDebug("Couldn't check the Inbox for replies to heals", cause),
    ),
  );

  yield* check.pipe(Effect.repeat(Schedule.spaced("1 minute")));
}).pipe(Effect.scoped);
