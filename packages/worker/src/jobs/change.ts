/**
 * The change job: have one agent make a change you asked for across several
 * repositories, in one session over checkouts side by side, each checked and
 * pushed on its own, so the same change isn't made again in each. It runs
 * the last of the heal agents, the one for hard work.
 */
import type { Domain } from "@upkeep/api";
import { Effect } from "effect";
import { attention, summary } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { skipped } from "../Worker";
import { across, type Checkout } from "./fix";

type Change = Extract<Domain.Command, { readonly kind: "change" }>;

/** What the agent is told: the change, where it's checked out and how far it may go. */
const prompt = (
  change: Change,
  checkouts: ReadonlyArray<Checkout>,
  minutes: number,
) => {
  const several = checkouts.length > 1;

  return [
    "You've been asked for this change:",
    "",
    change.prompt,
    "",
    ...(several
      ? [
          "Make it in each of these repositories, checked out side by side here:",
          "",
          ...checkouts.map(
            (checkout) =>
              `- ${checkout.repo} in ${checkout.directory} (${checkout.branch})`,
          ),
          "",
          "Make the change once and carry it to each, adapting it where they differ. Run each repository's own checks in its own checkout and push each to its default branch on its own once they pass, so one that can't be done doesn't hold up the rest.",
        ]
      : [
          `Make it in this checkout of ${checkouts[0]?.repo ?? ""}, run its checks and push it to the default branch once they pass.`,
        ]),
    "Never open a pull request. Anything you aren't sure of is for a person: stop and say what you found and what you'd do.",
    `You have ${minutes} minutes. End with a short summary of what you did${several ? " in each repository" : ""}, for a person reading it cold, then a last line of exactly one of \`Outcome: done\`, \`Outcome: nothing to do\` or \`Outcome: needs you\`${several ? ", which is `needs you` when any of them is left for a person" : ""}.`,
  ].join("\n");
};

export const change = Effect.fnUntraced(function* (
  command: Domain.Command | null,
) {
  if (command?.kind !== "change") {
    yield* RunLog.info("No change to make");

    return skipped;
  }

  const agent = ((yield* Settings.load()).heal?.agents ?? []).at(-1);

  if (agent === undefined) {
    yield* summary("Left for you: there's no agent in heal.agents to make it");
    yield* attention;

    return;
  }

  yield* RunLog.info(`Changing ${command.repos.join(", ")}: ${command.prompt}`);

  const result = yield* across(
    command.repos,
    agent,
    "change",
    (checkouts, minutes) => prompt(command, checkouts, minutes),
    () => Effect.void,
  );

  yield* summary(
    [
      result.said === null
        ? result.action
        : `${result.action}.\n\n${result.said}`,
      `Its session is ${result.session}, in ${result.directory}.`,
    ].join("\n\n"),
  );

  if (result.attention) yield* attention;
});
