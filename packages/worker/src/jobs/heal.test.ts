/** What the heal job offers to do about a failed run. */
import { expect, test } from "bun:test";
import { choices } from "./heal";

test("a run a heal queued isn't offered a retry", () => {
  expect(Object.keys(choices("heal"))).toEqual(["fix", "park", "ask"]);
  expect(Object.keys(choices("schedule"))).toContain("retry");
});
