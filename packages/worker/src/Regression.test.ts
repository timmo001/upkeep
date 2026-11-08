/** How the rules decide on regression checks, and what the model reads. */
import { expect, test } from "bun:test";
import {
  breaking,
  commands,
  decide,
  line,
  trimNotes,
  updateTypeOf,
  verdictOf,
} from "./Regression";

test("a major, or a minor below 1.0, needs a check", () => {
  expect(decide({ from: "1.4.0", to: "2.0.0", notes: "Fixes" })).toEqual({
    verdict: "check",
    why: "it's a major update",
  });
  expect(decide({ from: "0.12.0", to: "0.13.0", notes: "Fixes" })).toEqual({
    verdict: "check",
    why: "it's a minor update below 1.0",
  });
  expect(decide({ updateType: "major", notes: "Fixes" }).verdict).toBe("check");
});

test("a patch, digest, pin or lockfile-only update needs none, whatever its notes say", () => {
  const notes = "## Breaking changes\n\n- Removed `foo`";

  expect(decide({ from: "1.4.0", to: "1.4.1", notes })).toEqual({
    verdict: "skip",
    why: "it's a patch",
  });
  expect(decide({ updateType: "digest", notes }).verdict).toBe("skip");
  expect(decide({ updateType: "pin", notes }).verdict).toBe("skip");
  expect(decide({ updateType: "pinDigest", notes }).verdict).toBe("skip");
  expect(decide({ updateType: "major", lockfile: true, notes })).toEqual({
    verdict: "skip",
    why: "only the lockfile moves",
  });
});

test("an update with no release notes is never checked", () => {
  expect(decide({ from: "1.0.0", to: "2.0.0", notes: " \n" })).toEqual({
    verdict: "skip",
    why: "it has no release notes",
  });
});

test("a minor from 1.0 on is checked for breaking notes, and unclear without", () => {
  expect(
    decide({
      from: "1.4.0",
      to: "1.5.0",
      notes: "## What's changed\n\n- feat!: drop Node 20 by @someone",
    }),
  ).toEqual({
    verdict: "check",
    why: 'its release notes say "- feat!: drop Node 20 by @someone"',
  });
  expect(
    decide({ from: "1.4.0", to: "1.5.0", notes: "- Add a colour option" }),
  ).toEqual({
    verdict: "unclear",
    why: "it's a minor update with nothing breaking in its notes",
  });
  expect(decide({ from: "1.4.0", to: "1.5.0" })).toEqual({
    verdict: "unclear",
    why: "its release notes couldn't be read",
  });
});

test("an update whose versions aren't versions goes by its notes", () => {
  expect(decide({ notes: "BREAKING CHANGE: config moved" }).verdict).toBe(
    "check",
  );
  expect(decide({ from: "main", to: "next", notes: "Fixes" }).verdict).toBe(
    "unclear",
  );
  expect(updateTypeOf("main", "1.0.0")).toBeUndefined();
  expect(updateTypeOf("v1.2.3", "v1.3.0")).toBe("minor");
});

test("breaking markers in release notes", () => {
  expect(breaking("## ⚠ BREAKING CHANGES\n\n- something")).toBe(
    "## ⚠ BREAKING CHANGES",
  );
  expect(breaking("* fix(api)!: rename `run` to `start`")).toBe(
    "* fix(api)!: rename `run` to `start`",
  );
  expect(breaking("See the migration guide")).toBe("See the migration guide");
  expect(breaking("- Removed the old theme")).toBe("- Removed the old theme");
  expect(breaking("- `foo` is deprecated")).toBe("- `foo` is deprecated");
  expect(
    breaking(
      "- Update dependency effect to v4.1.2 by @renovate\n- A non-breaking fix\n- Fix: the menu",
    ),
  ).toBeUndefined();
  expect(breaking(`Breaking: ${"x".repeat(200)}`)).toHaveLength(100);
});

test("a repository's setting wins over its mise task, and opts in without one", () => {
  expect(commands(undefined, ["check"])).toBeUndefined();
  expect(commands(undefined, ["check", "regression"])).toEqual([
    "mise run --force regression",
  ]);
  expect(commands({ commands: ["npm run e2e"] }, ["regression"])).toEqual([
    "npm run e2e",
  ]);
  expect(commands({}, ["regression"])).toEqual(["mise run --force regression"]);
  expect(commands({}, [])).toEqual([]);
});

test("a held update's line names the release, why and its links", () => {
  expect(
    line({
      against: "timmo001/groundwork 0.13.0",
      why: "it's a minor update below 1.0",
      outcome: "so it's held",
      notes: "https://github.com/timmo001/groundwork/releases/tag/0.13.0",
      compare: "https://github.com/timmo001/groundwork/compare/0.12.0...0.13.0",
    }),
  ).toBe(
    "needs a regression check against timmo001/groundwork 0.13.0, as it's a minor update below 1.0, so it's held. Release notes: https://github.com/timmo001/groundwork/releases/tag/0.13.0, compare: https://github.com/timmo001/groundwork/compare/0.12.0...0.13.0.",
  );
});

test("the model reads the notes' first lines with text, each cut short", () => {
  expect(
    trimNotes("## What's changed\n\n  - Fix the menu  \n\n- Add dark mode"),
  ).toBe("## What's changed\n  - Fix the menu\n- Add dark mode");

  const long = Array.from(
    { length: 60 },
    (_, index) => `${index} ${"x".repeat(400)}`,
  ).join("\n");

  const trimmed = trimNotes(long).split("\n");

  expect(trimmed).toHaveLength(40);
  expect(trimmed[0]).toHaveLength(300);
  expect(trimmed[0]?.startsWith("0 ")).toBe(true);
});

test("a probability at or over the threshold needs a check", () => {
  expect(verdictOf(0.3, 0.3)).toBe("check");
  expect(verdictOf(0.9, 0.3)).toBe("check");
  expect(verdictOf(0.29, 0.3)).toBe("skip");
  expect(verdictOf(0, 0)).toBe("check");
});
