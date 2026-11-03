/**
 * The digest job: once a day, send the day's heals to the Inbox as one
 * message, so what Upkeep fixed, retried, parked or left can be read in one
 * place. A day with no heals sends nothing.
 */
import { Clock, Duration, Effect } from "effect";
import * as Inbox from "../Inbox";
import { Reporter } from "../Reporter";
import * as RunLog from "../RunLog";

export const digest = Effect.fnUntraced(function* () {
  const reporter = yield* Reporter;
  const now = yield* Clock.currentTimeMillis;
  const heals = yield* reporter.heals(now - Duration.toMillis("1 day"));

  if (heals.length === 0) {
    yield* RunLog.info("No heals today, so there's nothing to send");

    return;
  }

  const lines = heals.flatMap((run) => {
    const record = run.heal;

    if (record === null) return [];

    const target =
      record.target.kind === "upkeep" ? "Upkeep" : record.target.repo;

    return [
      `- **${record.job}** (${target}): ${record.decision ?? "undecided"}, ${run.state}${record.commit === null ? "" : `, fixed in ${record.commit.slice(0, 7)}`}`,
      ...record.actions.map((action) => `  - ${action}`),
    ];
  });

  yield* Inbox.send(
    `Upkeep: ${heals.length} heal${heals.length === 1 ? "" : "s"} today`,
    [`What Upkeep's heals did in the last day:`, "", ...lines].join("\n"),
    `upkeep-digest-${new Date(now).toISOString().slice(0, 10)}`,
  );

  yield* RunLog.info(`Sent the digest of ${heals.length} heals`);
});
