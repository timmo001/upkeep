/** Which updates the planner finds for a dependency, as Renovate would. */
import { expect, test } from "bun:test";
import { updatesFor } from "./Planner";
import type { Dependency, Policy, Releases } from "./Policy";

const policy: Policy = {
  updater: "renovate",
  updaterRuns: true,
  file: "renovate.json",
  settings: {},
  ignorePaths: [],
  enabledManagers: [],
  ignoreDeps: [],
  rules: [],
  customManagers: [],
  customDatasources: {},
  notes: [],
};

const v7 = "3d3c42e5aac5ba805825da76410c181273ba90b1";

const checkout: Dependency = {
  manager: "github-actions",
  file: ".github/workflows/ci.yml",
  depName: "actions/checkout",
  packageName: "actions/checkout",
  datasource: "github-tags",
  depType: "action",
  currentValue: "v7",
  currentDigest: v7,
};

// v7.0.1 is the commit v7 points at; v7.0.0 is older.
const v7Tags = [
  { version: "v7", digest: v7 },
  { version: "v7.0.0", digest: "9c091bb0d0f1b4c5d0e1d0a1f0e0b0c0d0e0f0a0" },
  { version: "v7.0.1", digest: v7 },
];

test("an action pinned at a major tag doesn't move within that major", () => {
  const releases: Releases = { releases: v7Tags };

  expect(updatesFor(policy, checkout, releases, 0).updates).toEqual([]);
});

test("an action pinned at a major tag moves to the next major tag", () => {
  const releases: Releases = {
    releases: [
      ...v7Tags,
      { version: "v8", digest: "f548e57d0f1b4c5d0e1d0a1f0e0b0c0d0e0f0a0b" },
    ],
  };

  const updates = updatesFor(policy, checkout, releases, 0).updates.map(
    ({ updateType, from, to }) => [updateType, from, to],
  );

  expect(updates).toEqual([["major", "v7", "v8"]]);
});

const astro: Dependency = {
  manager: "bun",
  file: "docs/package.json",
  depName: "astro",
  packageName: "astro",
  datasource: "npm",
  depType: "dependencies",
  currentValue: "^7.2.10",
};

test("a range with no locked version only updates past its range", () => {
  const releases: Releases = {
    releases: ["7.2.10", "7.4.5", "8.0.0"].map((version) => ({ version })),
  };

  const updates = updatesFor(policy, astro, releases, 0).updates.map(
    ({ updateType, from, to }) => [updateType, from, to],
  );

  expect(updates).toEqual([["major", "7.4.5", "8.0.0"]]);
});

const npmRunAll: Dependency = {
  ...astro,
  depName: "npm-run-all",
  packageName: "npm-run-all",
  currentValue: "^4.1.5",
};

const replacements: Policy = {
  ...policy,
  rules: [
    {
      match: { datasources: ["npm"], packageNames: ["npm-run-all"] },
      set: { replacementName: "npm-run-all2", replacementVersion: "5.0.0" },
    },
    {
      match: { updateTypes: ["replacement"] },
      set: { automerge: true },
    },
  ],
};

test("a replacement goes on its own branch beside the version updates", () => {
  const releases: Releases = {
    releases: ["4.1.5", "4.1.6"].map((version) => ({ version })),
  };

  const updates = updatesFor(replacements, npmRunAll, releases, 0).updates.map(
    ({ updateType, to, newName, branch, settings }) => [
      updateType,
      newName,
      to,
      branch,
      settings.automerge,
    ],
  );

  expect(updates).toEqual([
    ["replacement", "npm-run-all2", "5.0.0", "npm-run-all-replacement", true],
  ]);
});

test("a replacement that changes nothing isn't planned", () => {
  const same: Policy = {
    ...policy,
    rules: [
      {
        match: { packageNames: ["npm-run-all"] },
        set: { replacementVersion: "4.1.5" },
      },
    ],
  };

  expect(
    updatesFor(same, npmRunAll, { releases: [] }, 0).updates.filter(
      ({ updateType }) => updateType === "replacement",
    ),
  ).toEqual([]);
});
