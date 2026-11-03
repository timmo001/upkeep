/** How the bump job rewrites pins and dependencies in a consumer's files. */
import { expect, test } from "bun:test";
import { Edit, rewrite } from "./bump";

const old = "a".repeat(40);
const sha = "b".repeat(40);

test("a workflow pin moves to the release's commit, with its tag as a comment", () => {
  const text = [
    `    uses: timmo001/workflows/.github/workflows/lint.yml@${old} # v1.0.0`,
    `    uses: timmo001/workflows/.github/actions/setup@${old}`,
    `    uses: timmo001/workflows-extra/.github/workflows/lint.yml@${old}`,
  ].join("\n");

  expect(
    rewrite(
      Edit.Pins({ repo: "timmo001/workflows", sha, tag: "v1.1.0" }),
      text,
    ),
  ).toBe(
    [
      `    uses: timmo001/workflows/.github/workflows/lint.yml@${sha} # v1.1.0`,
      `    uses: timmo001/workflows/.github/actions/setup@${sha} # v1.1.0`,
      `    uses: timmo001/workflows-extra/.github/workflows/lint.yml@${old}`,
    ].join("\n"),
  );
});

test("a dependency keeps its range and skips workspace and git specs", () => {
  const edit = Edit.Dependency({
    name: "@timmo001/effect-gh",
    version: "0.11.0",
  });

  expect(rewrite(edit, `{ "@timmo001/effect-gh": "0.10.0" }`)).toBe(
    `{ "@timmo001/effect-gh": "0.11.0" }`,
  );
  expect(rewrite(edit, `{ "@timmo001/effect-gh": "^0.10.0" }`)).toBe(
    `{ "@timmo001/effect-gh": "^0.11.0" }`,
  );
  expect(rewrite(edit, `{ "@timmo001/effect-gh": "workspace:*" }`)).toBe(
    `{ "@timmo001/effect-gh": "workspace:*" }`,
  );
  expect(rewrite(edit, `{ "@timmo001/effect-gh-extra": "0.10.0" }`)).toBe(
    `{ "@timmo001/effect-gh-extra": "0.10.0" }`,
  );
});
