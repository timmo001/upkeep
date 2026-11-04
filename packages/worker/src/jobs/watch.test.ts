/** Which commits the watch job folds away as routine. */
import { expect, test } from "bun:test";
import { routine, titleOf } from "./watch";

test("a README's first heading is its title, without links or images", () => {
  expect(titleOf("![logo](logo.png)\n\n# System Bridge\n\nText")).toBe(
    "System Bridge",
  );
  expect(titleOf("# [Up Next](https://example.com) ![badge](b.svg)")).toBe(
    "Up Next",
  );
  expect(titleOf('<h1 align="center">Triage</h1>')).toBe("Triage");
  expect(titleOf("No heading here")).toBeNull();
});

test("lockfiles and tool config alone are routine", () => {
  expect(
    routine([{ filename: "bun.lock" }, { filename: "mise.toml" }]),
  ).toBeTrue();
});

test("a dependency version move in package.json is routine", () => {
  expect(
    routine([
      {
        filename: "packages/api/package.json",
        patch: '@@ -1 +1 @@\n-    "effect": "4.0.0",\n+    "effect": "4.0.1",',
      },
      { filename: "bun.lock" },
    ]),
  ).toBeTrue();
});

test("a workflow action pin move is routine", () => {
  expect(
    routine([
      {
        filename: ".github/workflows/ci.yml",
        patch:
          "@@ -1 +1 @@\n-      - uses: actions/checkout@aaa # v6\n+      - uses: actions/checkout@bbb # v7",
      },
    ]),
  ).toBeTrue();
});

test("a pin move in a Python requirements file is routine", () => {
  expect(
    routine([
      {
        filename: "connector/python/requirements_test.txt",
        patch:
          "@@ -1,3 +1,3 @@\n mypy==2.4.1\n-pytest-asyncio==1.4.1\n+pytest-asyncio==1.4.1.post1",
      },
    ]),
  ).toBeTrue();
});

test("a submodule move and any lockfile are routine", () => {
  expect(
    routine([
      {
        filename: "omarchy/plugins/agent-checks",
        patch: "@@ -1 +1 @@\n-Subproject commit aaa\n+Subproject commit bbb",
      },
      { filename: "herdr/plugins/plugins.lock" },
      { filename: ".mise/locks/npm-skills/1.7.6/aube-lock.yaml" },
    ]),
  ).toBeTrue();
});

test("a bot's commit is routine unless it touches source code", () => {
  const mirrored = [
    { filename: "upkeep/config.yaml" },
    { filename: "upkeep/CHANGELOG.md" },
  ];

  expect(routine(mirrored)).toBeFalse();
  expect(routine(mirrored, true)).toBeTrue();
  expect(routine([{ filename: "src/index.ts" }], true)).toBeFalse();
});

test("a script change in package.json is not routine", () => {
  expect(
    routine([
      {
        filename: "package.json",
        patch:
          '@@ -1,2 +1,3 @@\n+  "scripts": {\n+    "test": "bun test"\n+  },',
      },
    ]),
  ).toBeFalse();
});

test("any source file makes it worth reading", () => {
  expect(
    routine([{ filename: "bun.lock" }, { filename: "src/index.ts" }]),
  ).toBeFalse();
});

test("a manifest without a diff is not assumed routine", () => {
  expect(routine([{ filename: "package.json" }])).toBeFalse();
});
