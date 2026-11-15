/** Which items are new to tell you about, and the command run for each. */
import { expect, test } from "bun:test";
import type { Domain } from "@upkeep/api";
import { fill, fresh, fromAttention, fromStatus } from "./Notify";

const parked = fromStatus({
  kind: "needs",
  title: "Drift is parked",
  path: "jobs/drift",
  at: 1,
});

const change = fromStatus({
  kind: "skill-change",
  title: "Skill change waiting: herdr",
  path: "skills",
  at: 2,
});

test("only items not seen before are new", () => {
  const seen = new Set([parked.key]);

  expect(fresh(seen, [parked, change])).toEqual([change]);
  expect(fresh(new Set(), [])).toEqual([]);
});

test("the command gets the item's title and its dashboard page", () => {
  expect(
    fill(
      ["notify-send", "-a", "Upkeep", "{title}", "Open {url}"],
      parked,
      "http://homeassistant.local:7272/",
    ),
  ).toEqual([
    "notify-send",
    "-a",
    "Upkeep",
    "Drift is parked",
    "Open http://homeassistant.local:7272/jobs/drift",
  ]);
});

const item = (
  url: string,
  fields: Partial<Domain.AttentionItem>,
): Domain.AttentionItem => ({
  url,
  kind: "pull",
  repo: "octo/app",
  number: 7,
  title: "Fix the thing",
  author: "someone",
  yours: false,
  work: false,
  youActedLast: false,
  involved: true,
  activityAt: 1,
  updatedAt: 1,
  signals: [{ kind: "review-requested", detail: null }],
  labels: [],
  notification: null,
  fingerprint: url,
  section: "needs-you",
  firstSeen: 1,
  changedAt: 1,
  hidden: false,
  note: null,
  ...fields,
});

const page = (
  items: ReadonlyArray<Domain.AttentionItem>,
  workTime: boolean | null,
): Domain.Attention => ({
  items,
  groups: [],
  comments: [],
  rules: [],
  changes: [],
  releases: [],
  since: null,
  collectedAt: null,
  refreshAt: null,
  workTime,
  staleDays: 14,
});

test("Attention tells its Needs you items, and work ones only in work time", () => {
  const review = item("https://github.com/octo/app/pull/7", {});
  const work = item("https://github.com/work/app/pull/1", { work: true });

  const waiting = item("https://github.com/octo/app/pull/8", {
    section: "waiting",
  });

  const hidden = item("https://github.com/octo/app/pull/9", { hidden: true });

  const resting = fromAttention(page([review, work, waiting, hidden], false));

  expect(resting.seen).toEqual([
    "attention:https://github.com/octo/app/pull/7",
    "attention:https://github.com/work/app/pull/1",
  ]);
  expect(resting.tell).toEqual([
    {
      key: "attention:https://github.com/octo/app/pull/7",
      title: "octo/app#7: Fix the thing (review requested)",
      path: "attention",
    },
  ]);

  expect(
    fromAttention(page([review, work], true)).tell.map((told) => told.key),
  ).toEqual([
    "attention:https://github.com/octo/app/pull/7",
    "attention:https://github.com/work/app/pull/1",
  ]);
});
