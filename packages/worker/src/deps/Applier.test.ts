/** How the applier writes an update into a file, as Renovate would. */
import { expect, test } from "bun:test";
import { apply, Edit, newValue } from "./Applier";
import type { Update } from "./Planner";
import type { Dependency } from "./Policy";

const update = (
  dependency: Dependency,
  fields: Partial<Update> & Pick<Update, "to">,
): Update => ({
  dependency,
  updateType: "patch",
  from: dependency.currentValue,
  settings: {},
  branch: "branch",
  lockfile: false,
  ...fields,
});

const text = (edit: Edit) =>
  Edit.$match(edit, {
    Edited: ({ text }) => text,
    Unsupported: ({ reason }) => reason,
  });

test("a new value keeps the range operator, prefix and precision", () => {
  expect(newValue("^4.1.1", "4.1.2")).toBe("^4.1.2");
  expect(newValue("22", "24.1.0")).toBe("24");
  expect(newValue("v1.2.3", "1.3.0")).toBe("v1.3.0");
  expect(newValue(">=1 <2", "2.0.0")).toBeUndefined();
});

test("a package.json range moves and the rest is left alone", () => {
  const effect: Dependency = {
    manager: "bun",
    file: "package.json",
    depName: "effect",
    packageName: "effect",
    datasource: "npm",
    depType: "dependencies",
    currentValue: "^4.1.1",
  };

  const manifest = `{\n  "dependencies": {\n    "effect": "^4.1.1",\n    "@effect/platform-bun": "^4.1.1"\n  }\n}\n`;

  expect(text(apply(update(effect, { to: "4.1.2" }), manifest))).toBe(
    manifest.replace(`"effect": "^4.1.1"`, `"effect": "^4.1.2"`),
  );
});

test("a pinned action moves its commit and version comment", () => {
  const checkout: Dependency = {
    manager: "github-actions",
    file: ".github/workflows/ci.yml",
    depName: "actions/checkout",
    packageName: "actions/checkout",
    datasource: "github-tags",
    depType: "action",
    currentValue: "v7.0.0",
    currentDigest: "a".repeat(40),
  };

  const workflow = `      - uses: actions/checkout@${"a".repeat(40)} # v7.0.0\n      - uses: actions/setup-node@v5\n`;

  expect(
    text(
      apply(
        update(checkout, { to: "v7.0.1", digest: "b".repeat(40) }),
        workflow,
      ),
    ),
  ).toBe(
    `      - uses: actions/checkout@${"b".repeat(40)} # v7.0.1\n      - uses: actions/setup-node@v5\n`,
  );
});

test("a mise pin moves on its own line only", () => {
  const uv: Dependency = {
    manager: "mise",
    file: "mise.toml",
    depName: "uv",
    packageName: "astral-sh/uv",
    datasource: "github-releases",
    depType: "tools",
    currentValue: "0.13.6",
  };

  const config = `[tools]\nuv = "0.13.6"\nruff = "0.13.6"\n`;

  expect(text(apply(update(uv, { to: "0.13.7" }), config))).toBe(
    `[tools]\nuv = "0.13.7"\nruff = "0.13.6"\n`,
  );
});
