/**
 * The attention context job: ask an agent once about each Attention item that
 * changed since its last note, and each group one of its items left, rather
 * than on every collection. It reads each item's thread, then asks for a
 * one-line note with an optional recheck date, a follow-up on each group,
 * what to do about your comments, and links between items and groups, and
 * sends the answers to the server. It runs on the attention agent, or the
 * first of the heal agents.
 */
import { Graphql } from "@timmo001/effect-gh";
import type { Api, Domain } from "@upkeep/api";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { Effect, Option, Schema } from "effect";
import { reason } from "../Failure";
import { Reporter, summary } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { run } from "./bump";

/** The most items one run asks about, most urgent first. */
const maxItems = 20;

/** The most groups one run writes a follow-up for. */
const maxFollowUps = 5;

/** How much of a description or comment the agent reads. */
const maxText = 1200;

/** The sections worth a note; the backlog and Watching aren't. */
const urgent: ReadonlyArray<Domain.AttentionSection> = [
  "needs-you",
  "blocked",
  "stale",
  "waiting",
];

class NoAgent extends Schema.TaggedError<NoAgent>()("NoAgent", {}) {
  override get message() {
    return "No agent for the context: set attention.agent, or add one to heal.agents, in the worker's settings";
  }
}

class NoAnswer extends Schema.TaggedError<NoAnswer>()("NoAnswer", {
  reply: Schema.String,
}) {
  override get message() {
    return `The agent's reply wasn't the JSON asked for: ${this.reply.slice(0, 300)}`;
  }
}

const Comment = Schema.Struct({
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  body: Schema.String,
});

const Thread = Schema.Struct({
  resource: Schema.NullOr(
    Schema.Struct({
      body: Schema.optionalKey(Schema.String),
      comments: Schema.optionalKey(
        Schema.Struct({ nodes: Schema.Array(Schema.NullOr(Comment)) }),
      ),
    }),
  ),
});

const threadDocument = `
query ($url: URI!) {
  resource(url: $url) {
    ... on Issue { body comments(last: 5) { nodes { author { login } body } } }
    ... on PullRequest { body comments(last: 5) { nodes { author { login } body } } }
  }
}
`;

const clip = (text: string) =>
  text.length > maxText ? `${text.slice(0, maxText)}…` : text;

/** An item's description and its last few comments, or nothing on failure. */
const threadOf = (url: string) =>
  Graphql.query(threadDocument, { url }, Thread).pipe(
    Effect.map(({ resource }) =>
      [
        ...(resource?.body === undefined || resource.body.trim() === ""
          ? []
          : [`  Description: ${clip(resource.body.trim())}`]),
        ...(resource?.comments?.nodes ?? []).flatMap((comment) =>
          comment === null
            ? []
            : [
                `  Comment by ${comment.author?.login ?? "someone"}: ${clip(comment.body.trim())}`,
              ],
        ),
      ].join("\n"),
    ),
    Effect.catchCause((cause) =>
      RunLog.warn(`Couldn't read ${url}: ${reason(cause)}`).pipe(Effect.as("")),
    ),
  );

/** The agent's answer, each list optional so a quiet reply still decodes. */
const Answer = Schema.Struct({
  notes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        url: Schema.String,
        text: Schema.String,
        recheck: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  followUps: Schema.optionalKey(
    Schema.Array(Schema.Struct({ group: Schema.String, text: Schema.String })),
  ),
  comments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        outcome: Schema.String,
        rule: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  links: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        url: Schema.String,
        group: Schema.NullOr(Schema.String),
        suggested: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
});

const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Answer));

/** The JSON object in the agent's reply, without OpenCode's header lines. */
const answerOf = (output: string) => {
  const text = stripVTControlCharacters(output)
    .split("\n")
    .filter((line) => !line.startsWith("> "))
    .join("\n");

  return decodeAnswer(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
};

/** What one run asks about. */
export interface Asked {
  readonly items: ReadonlyArray<Domain.AttentionItem>;
  readonly followUps: ReadonlyArray<{
    readonly group: Domain.AttentionGroup;
    readonly gone: ReadonlyArray<Domain.AttentionChange>;
  }>;
  readonly comments: ReadonlyArray<Domain.AttentionComment>;
}

/**
 * What's worth asking about: items in the urgent sections, or in a group
 * pinned for today, whose note is missing or older than their last change,
 * up to `maxItems`, plus anything you commented on; and groups one of whose
 * items went since their last follow-up.
 */
export const askedOf = (page: Domain.Attention): Asked => {
  const comments = page.comments.filter((comment) => comment.doneAt === null);
  const commented = new Set(comments.flatMap((comment) => comment.url ?? []));

  const today = new Set(
    page.groups.flatMap((group) =>
      group.focus === "today" ? group.items.map((link) => link.url) : [],
    ),
  );

  const rank = (item: Domain.AttentionItem) => {
    const index = urgent.indexOf(item.section);

    return index === -1 ? urgent.length : index;
  };

  const stale = page.items
    .filter(
      (item) =>
        !item.hidden &&
        (urgent.includes(item.section) || today.has(item.url)) &&
        (item.note === null || item.note.fingerprint !== item.fingerprint),
    )
    .toSorted((a, b) => rank(a) - rank(b) || b.activityAt - a.activityAt)
    .slice(0, maxItems);

  const picked = new Set(stale.map((item) => item.url));

  const items = [
    ...stale,
    ...page.items.filter(
      (item) => commented.has(item.url) && !picked.has(item.url),
    ),
  ];

  const followUps = page.groups
    .flatMap((group) => {
      const gone = page.changes.filter(
        (change) =>
          change.gone &&
          change.group === group.id &&
          change.at > (group.followUp?.at ?? 0),
      );

      return gone.length === 0 ? [] : [{ group, gone }];
    })
    .slice(0, maxFollowUps);

  return { items, followUps, comments };
};

const day = (millis: number) => new Date(millis).toISOString().slice(0, 10);

/** The prompt: what to do, the standing rules, then what to look at. */
const promptFor = (
  page: Domain.Attention,
  asked: Asked,
  threads: ReadonlyMap<string, string>,
  now: number,
) => {
  const groupOf = new Map(
    page.groups.flatMap((group) =>
      group.items.map((link) => [link.url, group] as const),
    ),
  );

  const titles = new Map(page.items.map((item) => [item.url, item.title]));

  const describeItem = (item: Domain.AttentionItem) =>
    [
      `- ${item.url} [${item.section}${item.yours ? ", yours" : ""}] ${item.title}`,
      `  Signals: ${item.signals.map((signal) => signal.kind).join(", ") || "none"}; labels: ${item.labels.join(", ") || "none"}; last activity ${day(item.activityAt)}`,
      ...(groupOf.has(item.url)
        ? [`  In group ${groupOf.get(item.url)?.id}`]
        : []),
      ...(item.note === null
        ? []
        : [`  Your last note (${day(item.note.at)}): ${item.note.text}`]),
      ...asked.comments.flatMap((comment) =>
        comment.url === item.url
          ? [`  Comment ${comment.id} from the developer: ${comment.text}`]
          : [],
      ),
      threads.get(item.url) ?? "",
    ]
      .filter((line) => line !== "")
      .join("\n");

  const describeGroup = (group: Domain.AttentionGroup) =>
    [
      `- ${group.id} "${group.name}" (${group.focus}), with ${group.items
        .map((link) => titles.get(link.url) ?? link.url)
        .join("; ")}`,
      ...group.waits.map((wait) => `  Waits on: ${wait.text}`),
      ...asked.comments.flatMap((comment) =>
        comment.group === group.id
          ? [`  Comment ${comment.id} from the developer: ${comment.text}`]
          : [],
      ),
    ].join("\n");

  // Comments on an item no longer on the page, or a group since removed,
  // still need an answer, or they'd be asked about on every run
  const shownItems = new Set(asked.items.map((item) => item.url));
  const groupIds = new Set(page.groups.map((group) => group.id));

  const others = asked.comments.filter((comment) =>
    comment.url === null
      ? comment.group === null || !groupIds.has(comment.group)
      : !shownItems.has(comment.url),
  );

  return [
    "You keep a developer's Attention page in Upkeep: their GitHub pull requests and issues, sorted by what needs them. Read what's below and reply with one JSON object only, no other text, in this shape:",
    '{"notes": [{"url": "...", "text": "...", "recheck": "YYYY-MM-DD" or null}], "followUps": [{"group": "...", "text": "..."}], "comments": [{"id": "...", "outcome": "...", "rule": null or "..."}], "links": [{"url": "...", "group": "..." or null, "suggested": true}]}',
    "",
    `- notes: one per item below, a single plain sentence on where it stands and what it waits on, such as "Waiting on the December release". Give a recheck date only when it waits on something with a date; until then it stays out of Going stale. Today is ${day(now)}.`,
    "- followUps: one per group under Gone from groups, saying what that means for the rest: an issue to update or close, an item now unblocked, or nothing to do.",
    "- comments: one per developer comment, saying in a sentence what this reply does about it, and nothing it doesn't do. When a comment is a standing instruction rather than about one item, also give it as a short rule, and act on it in this reply too, such as taking out a suggestion it rules out with group null.",
    '- links: an item that plainly belongs to one of the groups and isn\'t in one, as a suggestion. When a comment asks to move an item, give it with "suggested": false, or group null to take it out.',
    "Write plain UK English, no em dashes, and don't invent anything that isn't below.",
    ...(page.rules.length === 0
      ? []
      : ["", "Standing rules:", ...page.rules.map((rule) => `- ${rule.text}`)]),
    "",
    "Items:",
    ...asked.items.map(describeItem),
    "",
    "Groups:",
    ...page.groups.slice(0, 60).map(describeGroup),
    ...(others.length === 0
      ? []
      : [
          "",
          "Comments about items or groups no longer on the page:",
          ...others.map(
            (comment) =>
              `- Comment ${comment.id} on ${comment.url ?? "a removed group"}: ${comment.text}`,
          ),
        ]),
    ...(asked.followUps.length === 0
      ? []
      : [
          "",
          "Gone from groups:",
          ...asked.followUps.map(
            ({ group, gone }) =>
              `- ${group.id}: ${gone.map((change) => `${change.title} (${change.url})`).join("; ")}`,
          ),
        ]),
  ].join("\n");
};

/**
 * The answers worth sending: notes only on items asked about, follow-ups and
 * links only to groups that exist, answers only to comments waiting.
 */
export const contextOf = (
  page: Domain.Attention,
  asked: Asked,
  answer: typeof Answer.Type,
): Api.AttentionContext => {
  const items = new Map(asked.items.map((item) => [item.url, item]));
  const groups = new Set(page.groups.map((group) => group.id));
  const comments = new Set(asked.comments.map((comment) => comment.id));
  const known = new Set(page.items.map((item) => item.url));

  return {
    notes: (answer.notes ?? []).flatMap((note) => {
      const item = items.get(note.url);
      const recheck = Date.parse(note.recheck ?? "");

      return item === undefined || note.text.trim() === ""
        ? []
        : [
            {
              url: note.url,
              text: note.text.trim(),
              recheckAt: Number.isNaN(recheck) ? null : recheck,
              fingerprint: item.fingerprint,
            },
          ];
    }),
    followUps: (answer.followUps ?? []).filter(
      (followUp) => groups.has(followUp.group) && followUp.text.trim() !== "",
    ),
    comments: (answer.comments ?? []).flatMap((comment) =>
      comments.has(comment.id)
        ? [
            {
              id: comment.id,
              outcome: comment.outcome,
              rule: comment.rule ?? null,
            },
          ]
        : [],
    ),
    links: (answer.links ?? []).flatMap((link) =>
      known.has(link.url) && (link.group === null || groups.has(link.group))
        ? [
            {
              url: link.url,
              group: link.group,
              suggested: link.suggested ?? true,
            },
          ]
        : [],
    ),
  };
};

export const attentionContext = Effect.fnUntraced(function* () {
  const reporter = yield* Reporter;
  const settings = yield* Settings.load();
  const agent = settings.attention?.agent ?? settings.heal?.agents?.[0];

  if (agent === undefined) return yield* new NoAgent();

  const page = yield* reporter.attentionPage();
  const asked = askedOf(page);

  if (
    asked.items.length === 0 &&
    asked.followUps.length === 0 &&
    asked.comments.length === 0
  ) {
    return yield* summary("Nothing new to read");
  }

  const threads = new Map(
    yield* Effect.forEach(
      asked.items,
      (item) =>
        threadOf(item.url).pipe(
          Effect.map((text) => [item.url, text] as const),
        ),
      { concurrency: 4 },
    ),
  );

  const model =
    agent.variant === undefined
      ? agent.model
      : `${agent.model}#${agent.variant}`;

  yield* RunLog.info(
    `Asking ${model} about ${asked.items.length} items, ${asked.followUps.length} groups and ${asked.comments.length} comments`,
  );

  const output = yield* run(
    settings.heal?.opencode ?? "opencode2",
    [
      "run",
      "--model",
      model,
      "--title",
      "Upkeep attention context",
      promptFor(page, asked, threads, Date.now()),
    ],
    { cwd: tmpdir(), trusted: tmpdir() },
  );

  const answer = answerOf(output);

  if (Option.isNone(answer)) return yield* new NoAnswer({ reply: output });

  const context = contextOf(page, asked, answer.value);

  yield* reporter.attentionContext(context);

  yield* summary(
    `${context.notes.length} notes, ${context.followUps.length} follow-ups, ${context.comments.length} comments answered, ${context.links.length} links`,
  );
});
