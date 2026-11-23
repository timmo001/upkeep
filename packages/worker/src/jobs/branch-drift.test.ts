/**
 * How the branch-drift job orders the branches it keeps, holds children back,
 * and says what a rebase changed.
 */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type BranchFile,
  changeSubject,
  inOrder,
  type Outcome,
  reworked,
  walk,
} from "./branch-drift";

const files = new Map<string, BranchFile>([
  ["cloud", { mode: "rebase", parent: "server" }],
  ["app", { mode: "rebase", parent: "server" }],
  ["server", { mode: "rebase", parent: "main" }],
  ["station", { mode: "rebase", parent: "main" }],
  ["mine", { mode: "own" }],
  ["lost", { mode: "rebase", parent: "gone" }],
  ["a", { mode: "rebase", parent: "b" }],
  ["b", { mode: "rebase", parent: "a" }],
]);

const branches = new Set([...files.keys(), "main"]);

test("parents go before their children, and broken branches are left out", () => {
  const { order, problems } = inOrder(files, branches);

  expect(order.map((entry) => entry.branch)).toEqual([
    "server",
    "station",
    "app",
    "cloud",
  ]);
  expect([...problems.keys()].toSorted()).toEqual(["a", "b", "lost"]);
});

test("a branch waits while its parent isn't in step", () => {
  const { order } = inOrder(files, branches);

  const outcomes = Effect.runSync(
    walk(order, new Set(), (entry) =>
      Effect.succeed<Outcome>(
        entry.branch === "server"
          ? { kind: "needs-you", note: "a conflict", raises: true }
          : { kind: "rebased", behind: 1 },
      ),
    ),
  );

  expect(Object.fromEntries(outcomes)).toEqual({
    server: { kind: "needs-you", note: "a conflict", raises: true },
    station: { kind: "rebased", behind: 1 },
    app: { kind: "waiting", on: "server" },
    cloud: { kind: "waiting", on: "server" },
  });
});

const rangeDiff = [
  "1:  7a25c7f = 1:  9dfd7d5 Add the station's monitors",
  "2:  805be4d ! 2:  b4ce1a9 Pin the station's tools",
  "3:  52e8a3e < -:  ------- Drop the old bar widget",
  "-:  ------- > 3:  2705597 Fix the pins after the rebase",
].join("\n");

test("only commits a rebase didn't replay as they were count", () => {
  expect(reworked(rangeDiff)).toEqual([
    { change: "changed", subject: "Pin the station's tools" },
    { change: "dropped", subject: "Drop the old bar widget" },
    { change: "added", subject: "Fix the pins after the rebase" },
  ]);
  expect(reworked(rangeDiff.split("\n")[0] ?? "")).toEqual([]);
});

test("the inbox says what changed, in the agent's words when it gave them", () => {
  const entry = { branch: "station", parent: "main", ignore: [] };
  const commits = reworked(rangeDiff);

  expect(
    changeSubject(
      entry,
      "Settled the mise.toml conflict.\nChange: Keep station's tool pins over main's",
      commits,
    ),
  ).toBe("Keep station's tool pins over main's");
  expect(changeSubject(entry, "Change: none", commits)).toBe(
    "Rebasing station onto main changed Pin the station's tools; dropped Drop the old bar widget; added Fix the pins after the rebase",
  );
});
