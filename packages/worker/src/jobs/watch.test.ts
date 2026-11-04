/** Which commits the watch job folds away as routine. */
import { expect, test } from "bun:test";
import { routine } from "./watch";

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
