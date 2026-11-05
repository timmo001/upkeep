/**
 * Messages to a person through the Plannotator Inbox: a heal that needs one
 * asks there. Sending never fails a job; a
 * missing or broken Inbox is logged and skipped.
 */
import { Config, Effect } from "effect";
import { run } from "./jobs/bump";
import * as RunLog from "./RunLog";
import * as Settings from "./settings";

/** The thread every Upkeep message goes to. */
const thread = "Upkeep heals";

/** Send `body` as markdown, starting the thread with `subject` when needed. */
export const send = Effect.fnUntraced(
  function* (subject: string, body: string, key: string) {
    const settings = (yield* Settings.load()).heal ?? {};
    const command = settings.inbox ?? "plannotator";

    if (command === false) return;

    const home = yield* Config.String("HOME");
    const project = settings.inboxProject ?? home;

    yield* run(
      command,
      [
        "inbox",
        "call",
        "send_message",
        JSON.stringify({
          subject,
          body,
          thread,
          project_path: project,
          idempotency_key: key,
        }),
      ],
      { cwd: project, trusted: project },
    );
  },
  Effect.catchCause((cause) =>
    RunLog.warn(`Couldn't send to the Inbox: ${String(cause).split("\n")[0]}`),
  ),
);
