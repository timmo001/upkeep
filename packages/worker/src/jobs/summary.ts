/**
 * The summary job: on request from the dashboard, ask an agent through
 * OpenCode for a longer write-up of what's in the inbox than the few
 * sentences the dashboard writes itself. It covers what's unread, or the
 * whole inbox when everything has been read, and its write-up becomes the
 * run's summary, which the inbox shows. It uses the first of the heal
 * agents in the worker's settings.
 */
import type { Domain } from "@upkeep/api";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { Effect, Schema } from "effect";
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

/** The prompt: how to write it, then the entries. */
const promptFor = (
  entries: ReadonlyArray<Domain.Entry>,
  routine: number,
  unreadOnly: boolean,
) =>
  [
    "You're writing a summary of a developer's inbox in Upkeep, a tool that keeps their repositories and their consumers up to date.",
    `Below are the ${unreadOnly ? "unread entries" : "entries from the last week"}: what needs them, releases of their repositories and where they went, dependency updates and tool moves that needed a change, fixes Upkeep pushed, and commits pushed outside Upkeep, by them or anyone else.`,
    `There were also ${routine} version bumps that changed no code; mention them only as a count.`,
    "",
    "Write a few short paragraphs in plain UK English, most important first: anything that needs them, then what was released and where it went, then their own work, then anything from outside worth knowing. Name repositories by their short names. Group related changes rather than listing commits. Don't invent anything that isn't below, don't use headings or em dashes, and keep it under 250 words.",
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

  const { entries } = yield* reporter.inbox();
  const unread = entries.filter((entry) => entry.readAt === null);
  const unreadOnly = unread.length > 0;
  const shown = unreadOnly ? unread : entries;
  const worth = shown.filter((entry) => !entry.routine);
  const routine = shown.length - worth.length;

  const model =
    agent.variant === undefined
      ? agent.model
      : `${agent.model}#${agent.variant}`;

  yield* RunLog.info(
    `Asking ${model} to write up ${worth.length} ${unreadOnly ? "unread " : ""}entries`,
  );

  const output = yield* run(
    settings.opencode ?? "opencode2",
    [
      "run",
      "--model",
      model,
      "--title",
      "Upkeep inbox summary",
      promptFor(worth, routine, unreadOnly),
    ],
    { cwd: tmpdir(), trusted: tmpdir() },
  );

  const written = replyOf(output);

  if (written === "") return yield* new EmptySummary();

  yield* report(written);
});
