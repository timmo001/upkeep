/** Which items are new to tell you about, and the command run for each. */
import { expect, test } from "bun:test";
import type { Domain } from "@upkeep/api";
import { fill, fresh } from "./Notify";

const parked: Domain.NeedsYou = {
  kind: "needs",
  title: "Drift is parked",
  path: "jobs/drift",
  at: 1,
};

const change: Domain.NeedsYou = {
  kind: "skill-change",
  title: "Skill change waiting: herdr",
  path: "skills",
  at: 2,
};

test("only items not seen before are new", () => {
  const seen = new Set([`${parked.kind}:${parked.path}:${parked.title}`]);

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
