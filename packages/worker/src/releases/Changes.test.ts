/**
 * A change's ID hashes what changed the way `dot git releases` did, so the
 * impact choices made there apply to the same changes here. A Bun lockfile's
 * packages resolve the way Bun nests them, so each gets its role. A path
 * counts as dependency updates only when every commit that touched it was
 * one, told apart from ordinary commits that also start with "Update".
 */
import { expect, test } from "bun:test";
import { bunLockChanges, parseUpdatesOnly, releaseFact } from "./Changes";

test("a fact's ID matches the one dot made for it", () => {
  const fact = releaseFact({
    kind: "file",
    path: "src/index.ts",
    previousPath: null,
    changeType: "modified",
    before: "100644:aaaa",
    after: "100644:bbbb",
    dependency: null,
    role: null,
    submodule: null,
    subject: null,
    detail: "M src/index.ts",
    complete: true,
    changedLines: 12,
  });

  expect(fact.id).toBe(
    "5449dca4557d89ac13e88fdc971a1634fc27dcabf651bef301e26d64292455b3",
  );
});

test("only paths every touching commit updated a dependency in are quiet", () => {
  const bot = "upkeep[bot] <1+upkeep[bot]@users.noreply.github.com>";

  // As `git log -z --name-only` prints it: a header, NUL and newline, then
  // NUL-separated paths
  const commit = (
    author: string,
    subject: string,
    coAuthor: string,
    paths: ReadonlyArray<string>,
  ) => `\x1e${author}\x1f${subject}\x1f${coAuthor}\0\n${paths.join("\0")}\0`;

  const updates = parseUpdatesOnly(
    [
      commit("Me", "Update Effect", bot, ["dist/index.js", "bun.lock"]),
      commit("Me", "Update oxlint to 1.91.0", "", ["package.json"]),
      commit("Me", "Update checks digest to c0562b3", "", ["ci.yml"]),
      commit("renovate[bot]", "Update github actions (#882)", "", ["a.yml"]),
      commit("Me", "Lock file maintenance (#900)", bot, ["bun.lock"]),
      commit("Me", "Update OpenCode 2", bot, ["page.ts"]),
      commit("Me", "Update views", "", ["views.ts"]),
      commit("Me", "Update docs to 2 columns", "", ["docs.ts"]),
      commit("Me", "Rebuild action bundles (#899)", bot, ["dist/other.js"]),
      commit("Me", "Run the AUR job when it's skipped", "", ["ci.yml"]),
    ].join(""),
  );

  expect([...updates].toSorted()).toEqual([
    "a.yml",
    "bun.lock",
    "dist/index.js",
    "package.json",
    "page.ts",
  ]);
});

test("a lockfile's packages resolve past scopes and from workspaces", () => {
  const lock = JSON.stringify({
    lockfileVersion: 1,
    workspaces: {
      "": { name: "app", dependencies: { "@npmcli/run-script": "10.0.4" } },
      plugin: { name: "@app/plugin", dependencies: { effect: "4.1.0" } },
    },
    packages: {
      "@app/plugin": ["@app/plugin@workspace:plugin"],
      "@app/plugin/effect": ["effect@4.1.0", "", {}, "sha512-a"],
      "@npmcli/node-gyp": ["@npmcli/node-gyp@5.0.0", "", {}, "sha512-b"],
      "@npmcli/run-script": [
        "@npmcli/run-script@10.0.4",
        "",
        {
          dependencies: { "@npmcli/node-gyp": "^5.0.0", "node-gyp": "^12.1.0" },
        },
        "sha512-c",
      ],
      "node-gyp": ["node-gyp@12.4.0", "", {}, "sha512-d"],
    },
  });

  const { facts, errors } = bunLockChanges("bun.lock", null, lock, {
    policy: "application",
    versioning: "semver",
    fork: null,
    sourceMinorThreshold: undefined,
    sourceExcludes: [],
    overrides: [],
  });

  expect(errors).toEqual([]);
  expect(facts.map((fact) => [fact.detail, fact.role])).toEqual([
    ["Locked package: @app/plugin/effect", "runtime"],
    ["Locked package: @npmcli/node-gyp", "runtime"],
    ["Locked package: @npmcli/run-script", "runtime"],
    ["Locked package: node-gyp", "runtime"],
  ]);
});
