/** How the drift job picks a tool's newest tag and records a review. */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { decode, derivedFiles, newestTag, recordReviewed } from "./drift";

test("the newest tag is the highest stable version matching the pattern", () => {
  const tags = [
    "effect@4.0.9",
    "effect@4.0.10",
    "effect@4.1.0-beta.1",
    "@effect/platform-node@4.2.0",
    "effect@3.19.4",
  ];

  expect(newestTag(tags, "^effect@")).toBe("effect@4.0.10");
  expect(newestTag(tags, "^nothing@")).toBeUndefined();
});

test("prereleases count when included, and give way to their stable version", () => {
  const tags = ["v4.0.6", "v4.5.0-rc1", "v4.5.0-rc2", "v4.0.5"];

  expect(newestTag(tags, "", true)).toBe("v4.5.0-rc2");
  expect(newestTag(tags, "")).toBe("v4.0.6");
  expect(newestTag([...tags, "v4.5.0"], "", true)).toBe("v4.5.0");
  expect(newestTag(["v1.0.0-rc9", "v1.0.0-rc10"], "", true)).toBe(
    "v1.0.0-rc10",
  );
});

test("two-part versions count, such as Home Assistant frontend's", () => {
  expect(newestTag(["20260930.5", "20261104.0", "20250101.12"], "")).toBe(
    "20261104.0",
  );
  expect(newestTag(["v1.2", "v1.2.1", "v1.10"], "")).toBe("v1.10");
});

const file = `---
# Tool releases this repository is reviewed against
tools:
  - repo: cli/cli
    reviewed: v2.89.0
    update: mise run tooling:refresh
  - repo: herdrdev/herdr
    reviewed: "v0.9.2" # quoted on purpose
`;

test("recording a review moves one tool's tag and keeps the rest as written", () => {
  const updated = recordReviewed(file, "herdrdev/herdr", "v0.9.3");

  expect(updated).toContain("reviewed: v0.9.3");
  expect(updated).toContain("reviewed: v2.89.0");
  expect(updated).toContain("# Tool releases this repository");
  expect(recordReviewed(file, "missing/tool", "v9")).toBe(file);
});

test("a tag YAML would read as a number is quoted", async () => {
  const updated = recordReviewed(file, "herdrdev/herdr", "20261028.0");

  expect(updated).toContain('reviewed: "20261028.0"');

  const decoded = await Effect.runPromise(decode(updated));

  expect(decoded.tools[1]?.reviewed).toBe("20261028.0");
});

test("only files outside the pins need a review", () => {
  const tool = { repo: "cli/cli", reviewed: "v1", update: "true" };

  expect(derivedFiles(tool, ["tooling.yml"])).toEqual([]);
  expect(derivedFiles(tool, ["tooling.yml", "tooling/gh/help.txt"])).toEqual([
    "tooling/gh/help.txt",
  ]);
});
