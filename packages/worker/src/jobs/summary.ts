/**
 * The summary job: on request from the dashboard, ask an agent through
 * OpenCode for a longer write-up of what's in the inbox than the few
 * sentences the dashboard writes itself. It covers what's unread, or the
 * whole inbox when everything has been read, records that period on the run
 * and names it in the write-up, which becomes the run's summary and the
 * inbox shows. It uses the first of the heal agents in the worker's settings,
 * and records its model and variant on the run.
 */
import { Domain } from "@upkeep/api";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { Clock, Effect, Schema } from "effect";
import { Reporter, summary as report } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { run } from "./bump";

/** The most repositories an entry lists for the agent. */
const maxItems = 12;

class NoAgent extends Schema.TaggedError<NoAgent>()("NoAgent", {}) {
  override get message() {
    return "No agent to write the summary: add one to heal.agents in the worker's settings";
  }
}

class EmptySummary extends Schema.TaggedError<EmptySummary>()(
  "EmptySummary",
  {},
) {
  override get message() {
    return "The agent wrote nothing";
  }
}

/** One entry as the agent reads it. */
const describeEntry = (entry: Domain.Entry) =>
  [
    `- [${entry.kind}${entry.you ? ", by you" : ""}${entry.readAt === null ? ", unread" : ""}] ${entry.title}`,
    ...(entry.detail === null ? [] : [`  ${entry.detail}`]),
    ...entry.items
      .slice(0, maxItems)
      .map((item) => `  - ${item.repo}: ${item.text}`),
    ...(entry.items.length > maxItems
      ? [`  - and ${entry.items.length - maxItems} more`]
      : []),
  ].join("\n");

const { describePeriod, periodDay } = Domain;

/**
 * What the summary covers: the unread entries, from the oldest change among
 * them or the inbox's window, whichever is earlier, or every entry in the
 * window when nothing is unread. It ends now.
 */
const periodOf = (
  inbox: Domain.Inbox,
  unread: ReadonlyArray<Domain.Entry>,
  now: number,
): Domain.Period => ({
  from: Math.min(inbox.since, ...unread.map((entry) => entry.lastAt)),
  to: now,
  unread: unread.length > 0,
});

/** The prompt: how to write it, then the entries. */
const promptFor = (
  entries: ReadonlyArray<Domain.Entry>,
  routine: number,
  period: Domain.Period,
) =>
  [
    "You're writing a summary of a developer's inbox in Upkeep, a tool that keeps their repositories and their consumers up to date.",
    `Below are ${describePeriod(period)}: what needs them, releases of their repositories and where they went, dependency updates and tool moves that needed a change, fixes Upkeep pushed, and commits pushed outside Upkeep, by them or anyone else.`,
    `There were also ${routine} version bumps that changed no code; mention them only as a count.`,
    "",
    `Start with a sentence that names the period it covers, such as "Between ${periodDay(period.from)} and ${periodDay(period.to)}", never "this week".`,
    "Then write a few short paragraphs in plain UK English, most important first: anything that needs them, then what was released and where it went, then their own work, then anything from outside worth knowing. Name repositories by their short names. Group related changes rather than listing commits. Don't invent anything that isn't below, don't use headings or em dashes, and keep it under 250 words.",
    "Reply with the summary only.",
    "",
    ...entries.map(describeEntry),
  ].join("\n");

/** The agent's reply, without OpenCode's own header lines. */
const replyOf = (output: string) =>
  stripVTControlCharacters(output)
    .split("\n")
    .filter((line) => !line.startsWith("> "))
    .join("\n")
    .trim();

export const summary = Effect.fnUntraced(function* () {
  const reporter = yield* Reporter;
  const settings = (yield* Settings.load()).heal ?? {};
  const agent = settings.agents?.[0];

  if (agent === undefined) return yield* new NoAgent();

  const inbox = yield* reporter.inbox();
  const unread = inbox.entries.filter((entry) => entry.readAt === null);
  const period = periodOf(inbox, unread, yield* Clock.currentTimeMillis);
  const shown = period.unread ? unread : inbox.entries;
  const worth = shown.filter((entry) => !entry.routine);
  const routine = shown.length - worth.length;

  const model =
    agent.variant === undefined
      ? agent.model
      : `${agent.model}#${agent.variant}`;

  yield* reporter.report({ period, agent: Settings.agentModel(agent) });

  yield* RunLog.info(
    `Asking ${model} to write up ${worth.length} entries, ${describePeriod(period)}`,
  );

  const output = yield* run(
    settings.opencode ?? "opencode2",
    [
      "run",
      "--model",
      model,
      "--title",
      "Upkeep inbox summary",
      promptFor(worth, routine, period),
    ],
    { cwd: tmpdir(), trusted: tmpdir() },
  );

  const written = replyOf(output);

  if (written === "") return yield* new EmptySummary();

  yield* report(written);
});
