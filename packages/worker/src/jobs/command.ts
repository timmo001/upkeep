/**
 * The command job: do one thing the server asked for on demand, such as mark
 * a GitHub notification read from the Attention page, start an agent on
 * an item there or to prepare a release, open an agent's session, or have a
 * session ask you in the Plannotator Inbox. Each run carries its
 * command; a run without one, such as from the run button, has nothing to do.
 */
import { Api } from "@timmo001/effect-gh";
import type { Domain } from "@upkeep/api";
import { Effect } from "effect";
import { summary } from "../Reporter";
import * as RunLog from "../RunLog";
import { skipped } from "../Worker";
import { askInbox, launch, releaseAgent, resume } from "./launch";

export const command = Effect.fnUntraced(function* (
  command: Domain.Command | null,
) {
  if (command === null) {
    yield* RunLog.info("No command to run");

    return skipped;
  }

  switch (command.kind) {
    case "mark-read": {
      yield* Api.empty({
        endpoint: `notifications/threads/${command.thread}`,
        method: "PATCH",
      });
      yield* summary(`Marked notification ${command.thread} read`);

      return;
    }

    case "start-agent":
      return yield* launch(command);

    case "open-session":
      return yield* resume(command);

    case "ask-inbox":
      return yield* askInbox(command);

    case "release-agent":
      return yield* releaseAgent(command);
  }
});
