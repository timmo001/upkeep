/** How the bump job rewrites a consumer's files and reports a failed check. */
import { expect, test } from "bun:test";
import {
  compareLink,
  currentVersions,
  Edit,
  failedOutput,
  needed,
  rewrite,
} from "./bump";

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

test("a package's current versions are read before the rewrite, versions only", () => {
  const text = [
    `"@timmo001/effect-gh": "^0.12.0",`,
    `"@timmo001/effect-gh-extra": "1.0.0",`,
    `"@timmo001/effect-gh": "workspace:*",`,
    `"@timmo001/effect-gh": "~0.11.2"`,
  ].join("\n");

  expect(currentVersions("@timmo001/effect-gh", text)).toEqual([
    "0.12.0",
    "0.11.2",
  ]);
});

test("a compare link needs the release's tag to name its version", () => {
  const release = { repo: "timmo001/groundwork", url: "", tag: "v0.13.0" };

  expect(compareLink(release, "0.12.0", "0.13.0")).toBe(
    "https://github.com/timmo001/groundwork/compare/v0.12.0...v0.13.0",
  );
  expect(
    compareLink({ ...release, tag: "@scope/pkg@0.13.0" }, "0.12.0", "0.13.0"),
  ).toBe(
    "https://github.com/timmo001/groundwork/compare/@scope/pkg@0.12.0...@scope/pkg@0.13.0",
  );
  expect(
    compareLink({ ...release, tag: "release-7" }, "0.12.0", "0.13.0"),
  ).toBeUndefined();
});

test("a package needs the release's packages it depends on, through others too", () => {
  const dependencies = new Map([
    ["docs-kit", ["groundwork"]],
    ["groundwork", ["tokens", "docs-kit"]],
    ["tokens", []],
    ["other", []],
  ]);

  expect(needed("docs-kit", dependencies).toSorted()).toEqual([
    "docs-kit",
    "groundwork",
    "tokens",
  ]);
  expect(needed("other", dependencies)).toEqual(["other"]);
});

/** A coloured task prefix, as mise writes it with CI set. */
const prefix = (task: string, colour: string) =>
  `\u001B[${colour}m[${task}]\u001B[0m`;

const types = prefix("check:types", "38;5;13");
const lint = prefix("check:lint", "38;5;10");

test("a failed mise check shows the failed task's lines and mise's error", () => {
  // stderr then stdout, as the bump job collects them
  const stderr = [
    `${lint} \u001B[1m$ oxlint\u001B[0m`,
    `${types} \u001B[1m$ tsc --noEmit\u001B[0m`,
    `${types} src/index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.`,
    "\u001B[2mFinished in 2.1s\u001B[0m",
    `${types} \u001B[31mERROR\u001B[0m task failed`,
  ];

  const stdout = [
    `${types} Checking 12 files`,
    ...Array.from({ length: 30 }, (_, i) => `${lint} src/file-${i}.ts: ok`),
  ];

  expect(failedOutput(`${stderr.join("\n")}\n${stdout.join("\n")}`)).toBe(
    [
      "[check:types] $ tsc --noEmit",
      "[check:types] src/index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "[check:types] Checking 12 files",
      "[check:types] ERROR task failed",
    ].join("\n"),
  );
});

test("a task mise ran on its own keeps its unprefixed lines", () => {
  const output = [
    `${types} \u001B[1m$ tsc --noEmit\u001B[0m`,
    "src/index.ts(3,7): error TS2322",
    `${types} \u001B[31mERROR\u001B[0m task failed`,
  ].join("\n");

  expect(failedOutput(output)).toBe(output);
});
