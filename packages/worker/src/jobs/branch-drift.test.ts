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

const commit = (subject: string, lines: string) => ({
  key: `1 me ${subject}`,
  subject,
  lines,
});

test("commits replayed with the same lines, or only touching what's ignored, don't count", () => {
  expect(
    reworked(
      [
        commit("Add the station's monitors", "+monitor"),
        commit("Pin the station's tools", "+node 24"),
        commit("Drop the old bar widget", "-widget"),
        commit("Regenerate the diff page", ""),
      ],
      [
        commit("Add the station's monitors", "+monitor"),
        commit("Pin the station's tools", "+node 26"),
        commit("Fix the pins after the rebase", "+pin"),
        commit("Regenerate the diff page again", ""),
      ],
    ),
  ).toEqual([
    "Pin the station's tools",
    "Fix the pins after the rebase",
    "Drop the old bar widget",
  ]);
  expect(
    reworked([commit("Add monitors", "+m")], [commit("Add monitors", "+m")]),
  ).toEqual([]);
});

test("the inbox says what changed, in the agent's words when it gave them", () => {
  const said =
    "Settled the mise.toml conflict.\nChange: Keep station's tool pins over main's";

  expect(changeSubject(said, ["Pin the station's tools"])).toBe(
    "Keep station's tool pins over main's",
  );
  expect(changeSubject("Change: none", ["Pin the station's tools"])).toBe(
    "Pin the station's tools",
  );
  expect(changeSubject(null, ["Pin the tools", "Fix the pins"])).toBe(
    "Pin the tools, and 1 more",
  );
  expect(changeSubject(said, [])).toBeNull();
});
