/** How the branch-drift job orders the branches it keeps, and holds children back. */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { type BranchFile, inOrder, type Outcome, walk } from "./branch-drift";

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
