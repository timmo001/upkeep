/** Which GitHub releases' notes an update takes in. */
import { expect, test } from "bun:test";
import { notesBetween } from "./Datasources";
import type { Release } from "./Policy";

const release = (version: string, notes: string): Release => ({
  version,
  notes,
  url: `https://github.com/owner/name/releases/tag/${version}`,
});

test("the notes of each release after the version in use, up to the new one", () => {
  const releases = [
    release("v1.6.0", "Too new"),
    release("v1.5.0", "- Add a colour option"),
    release("v1.4.1", ""),
    release("v1.4.0", "- Removed `foo`"),
    release("v1.3.0", "Already in use"),
  ];

  expect(
    notesBetween("owner/name", releases, "name", "1.3.0", "1.5.0"),
  ).toEqual({
    text: "- Add a colour option\n\n- Removed `foo`",
    url: "https://github.com/owner/name/releases/tag/v1.5.0",
    compare: "https://github.com/owner/name/compare/v1.3.0...v1.5.0",
  });
});

test("a monorepo's releases are matched by the package's name", () => {
  const releases = [
    release("@scope/other@2.1.0", "Breaking: not this one"),
    release("@scope/pkg@2.1.0", "- Fixes"),
  ];

  expect(
    notesBetween("owner/name", releases, "@scope/pkg", "^2.0.0", "2.1.0")?.text,
  ).toBe("- Fixes");
});

test("no release for the new version means the notes couldn't be read", () => {
  expect(
    notesBetween(
      "owner/name",
      [release("v1.4.0", "")],
      "name",
      "1.3.0",
      "1.5.0",
    ),
  ).toBeUndefined();
  expect(
    notesBetween(
      "owner/name",
      [release("v1.5.0", "")],
      "name",
      "1.3.0",
      "1.5.0",
    )?.text,
  ).toBe("");
});
