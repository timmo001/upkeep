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
  expect(newValue("0.0.0-alpha.4", "0.0.0-alpha.6")).toBe("0.0.0-alpha.6");
  expect(newValue("^1.0.0-rc.1", "1.0.0")).toBe("^1.0.0");
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

test("an image moves its tag and digest, and leaves longer names alone", () => {
  const node: Dependency = {
    manager: "dockerfile",
    file: "Dockerfile",
    depName: "node",
    packageName: "node",
    datasource: "docker",
    depType: "final",
    currentValue: "22-alpine",
  };

  const dockerfile =
    "FROM node:22-alpine AS build\nFROM node:22-alpine3.20\nFROM my/node:22-alpine\n";

  expect(
    text(
      apply(
        update(node, {
          updateType: "pinDigest",
          to: "abc1234",
          digest: "sha256:abc",
        }),
        dockerfile,
      ),
    ),
  ).toBe(
    dockerfile.replace("node:22-alpine AS", "node:22-alpine@sha256:abc AS"),
  );

  const pinned = { ...node, currentDigest: "sha256:abc" };

  expect(
    text(
      apply(
        update(pinned, {
          updateType: "major",
          to: "24-alpine",
          digest: "sha256:def",
        }),
        "image: node:22-alpine@sha256:abc\n",
      ),
    ),
  ).toBe("image: node:24-alpine@sha256:def\n");

  expect(
    text(
      apply(
        update(pinned, { updateType: "major", to: "24-alpine" }),
        "image: node:22-alpine@sha256:abc\n",
      ),
    ),
  ).toBe("no digest for node:24-alpine");
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

test("a mise tool in its own table moves its version line", () => {
  const fzfTab: Dependency = {
    manager: "mise",
    file: "config.toml",
    depName: "http:fzf-tab",
    packageName: "Aloxaf/fzf-tab",
    datasource: "github-tags",
    depType: "tools",
    currentValue: "1.3.0",
  };

  const config = `[tools."http:other"]\nversion = "1.3.0"\n\n[tools."http:fzf-tab"]\nversion = "1.3.0"\nurl = "https://example.com"\n`;

  expect(text(apply(update(fzfTab, { to: "v1.4.0" }), config))).toBe(
    `[tools."http:other"]\nversion = "1.3.0"\n\n[tools."http:fzf-tab"]\nversion = "1.4.0"\nurl = "https://example.com"\n`,
  );
});

test("a custom regex match moves its digest in place", () => {
  const plugin: Dependency = {
    manager: "custom.regex",
    file: "plugins.list",
    depName: "timmo001/agent-checks",
    packageName: "https://github.com/timmo001/agent-checks.git",
    datasource: "git-refs",
    depType: "regex",
    currentValue: "main",
    currentDigest: "a".repeat(40),
    replaceString: `timmo001/agent-checks@${"a".repeat(40)}`,
  };

  const list = `owner/other@${"a".repeat(40)}\ntimmo001/agent-checks@${"a".repeat(40)}\n`;

  expect(
    text(
      apply(
        update(plugin, {
          to: "bbbbbbb",
          updateType: "digest",
          digest: "b".repeat(40),
        }),
        list,
      ),
    ),
  ).toBe(
    `owner/other@${"a".repeat(40)}\ntimmo001/agent-checks@${"b".repeat(40)}\n`,
  );
});

test("a jsonata result is only swapped when its value appears once", () => {
  const bun: Dependency = {
    manager: "custom.jsonata",
    file: ".github/workflows/build.yml",
    depName: "bun",
    packageName: "bun",
    datasource: "npm",
    depType: "jsonata",
    currentValue: "1.4.4",
  };

  const inputs = `bun-version:\n  default: "1.4.4"\nother-version:\n  default: "11.4.4"\n`;

  expect(text(apply(update(bun, { to: "1.5.0" }), inputs))).toBe(
    `bun-version:\n  default: "1.5.0"\nother-version:\n  default: "11.4.4"\n`,
  );

  expect(
    apply(
      update(bun, { to: "1.5.0" }),
      `${inputs}node-version:\n  default: "1.4.4"\n`,
    )._tag,
  ).toBe("Unsupported");
});

test("a replacement renames the package.json entry and moves its range", () => {
  const npmRunAll: Dependency = {
    manager: "npm",
    file: "package.json",
    depName: "npm-run-all",
    packageName: "npm-run-all",
    datasource: "npm",
    depType: "devDependencies",
    currentValue: "^4.1.5",
  };

  const manifest = `{\n  "devDependencies": {\n    "npm-run-all": "^4.1.5",\n    "npm-run-all-extra": "^4.1.5"\n  }\n}\n`;

  expect(
    text(
      apply(
        update(npmRunAll, {
          updateType: "replacement",
          to: "5.0.0",
          newName: "npm-run-all2",
        }),
        manifest,
      ),
    ),
  ).toBe(
    manifest.replace(`"npm-run-all": "^4.1.5"`, `"npm-run-all2": "^5.0.0"`),
  );
});

test("a replacement renames an action and keeps its tag", () => {
  const provenance: Dependency = {
    manager: "github-actions",
    file: ".github/workflows/release.yml",
    depName: "actions/attest-build-provenance",
    packageName: "actions/attest-build-provenance",
    datasource: "github-tags",
    depType: "action",
    currentValue: "v4",
  };

  const replace = update(provenance, {
    updateType: "replacement",
    to: "v4",
    newName: "actions/attest",
  });

  expect(
    text(apply(replace, `      - uses: actions/attest-build-provenance@v4\n`)),
  ).toBe(`      - uses: actions/attest@v4\n`);

  expect(
    apply(
      update(
        { ...provenance, currentDigest: "a".repeat(40) },
        { updateType: "replacement", to: "v4", newName: "actions/attest" },
      ),
      `      - uses: actions/attest-build-provenance@${"a".repeat(40)} # v4\n`,
    )._tag,
  ).toBe("Unsupported");
});
