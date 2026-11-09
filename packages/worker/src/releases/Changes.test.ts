/**
 * A change's ID hashes what changed the way `dot git releases` did, so the
 * impact choices made there apply to the same changes here.
 */
import { expect, test } from "bun:test";
import { releaseFact } from "./Changes";

test("a fact's ID matches the one dot made for it", () => {
  const fact = releaseFact({
    kind: "file",
    path: "src/index.ts",
    previousPath: null,
    changeType: "modified",
    before: "100644:aaaa",
    after: "100644:bbbb",
    dependency: null,
    role: null,
    submodule: null,
    subject: null,
    detail: "M src/index.ts",
    complete: true,
    changedLines: 12,
  });

  expect(fact.id).toBe(
    "5449dca4557d89ac13e88fdc971a1634fc27dcabf651bef301e26d64292455b3",
  );
});
