/** Which updates the planner finds for a dependency, as Renovate would. */
import { expect, test } from "bun:test";
import { type Update, updatesFor, vulnerabilities } from "./Planner";
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
  unmodelled: [],
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

const astroReleases: Releases = {
  releases: ["7.2.10", "7.2.11", "7.4.5", "8.0.0"].map((version) => ({
    version,
  })),
};

test("a locked range moves its lockfile within the range, from the locked version", () => {
  const updates = updatesFor(
    policy,
    { ...astro, lockedVersion: "7.2.10" },
    astroReleases,
    0,
  ).updates.map(({ updateType, from, to, lockfile, branch }) => [
    updateType,
    from,
    to,
    lockfile,
    branch,
  ]);

  expect(updates).toEqual([
    ["minor", "7.2.10", "7.4.5", true, "astro-7.x-lockfile"],
    ["major", "7.2.10", "8.0.0", false, "astro-8.x"],
  ]);
});

test("a locked range with bump or a peer dependency moves the range alone", () => {
  const bump: Policy = {
    ...policy,
    rules: [{ match: {}, set: { rangeStrategy: "bump" } }],
  };

  for (const [rules, dependency] of [
    [bump, { ...astro, lockedVersion: "7.2.10" }],
    [
      policy,
      { ...astro, depType: "peerDependencies", lockedVersion: "7.2.10" },
    ],
  ] as const)
    expect(
      updatesFor(rules, dependency, astroReleases, 0).updates.map(
        ({ from, to, lockfile }) => [from, to, lockfile],
      ),
    ).toEqual([["7.4.5", "8.0.0", false]]);
});

test("in-range-only keeps to the lockfile, and to the range without a locked version", () => {
  const inRangeOnly: Policy = {
    ...policy,
    rules: [{ match: {}, set: { rangeStrategy: "in-range-only" } }],
  };

  expect(
    updatesFor(
      inRangeOnly,
      { ...astro, lockedVersion: "7.2.10" },
      astroReleases,
      0,
    ).updates.map(({ from, to, lockfile }) => [from, to, lockfile]),
  ).toEqual([["7.2.10", "7.4.5", true]]);
  expect(updatesFor(inRangeOnly, astro, astroReleases, 0).updates).toEqual([]);
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

const node: Dependency = {
  manager: "dockerfile",
  file: "Dockerfile",
  depName: "node",
  packageName: "node",
  datasource: "docker",
  depType: "final",
  currentValue: "22.11.0-alpine",
};

const nodeTags: Releases = {
  releases: [
    "22.11.0-alpine",
    "22.12.0-alpine",
    "22.12.0",
    "22.13-alpine",
    "24.1.0-alpine3.20",
    "24.1.0-alpine",
    "25.0.0rc1-alpine",
    "latest",
  ].map((version) => ({ version, digest: `sha256:${version}` })),
};

const planned = (plan: { updates: ReadonlyArray<Update> }) =>
  plan.updates.map(({ updateType, from, to, digest }) => [
    updateType,
    from,
    to,
    digest,
  ]);

test("an image's tag only moves to tags with its suffix and its number of parts", () => {
  expect(planned(updatesFor(policy, node, nodeTags, 0))).toEqual([
    ["minor", "22.11.0-alpine", "22.12.0-alpine", undefined],
    ["major", "22.11.0-alpine", "24.1.0-alpine", undefined],
  ]);
});

test("a pinned image keeps its digest through a new tag, and moves it on its own tag", () => {
  const pinned = { ...node, currentDigest: "sha256:old" };

  expect(planned(updatesFor(policy, pinned, nodeTags, 0))).toEqual([
    ["digest", "old", "22.11.0", "sha256:22.11.0-alpine"],
    ["minor", "22.11.0-alpine", "22.12.0-alpine", "sha256:22.12.0-alpine"],
    ["major", "22.11.0-alpine", "24.1.0-alpine", "sha256:24.1.0-alpine"],
  ]);
});

test("an image on a tag that isn't a version only has its digest pinned", () => {
  const latest = { ...node, currentValue: "latest" };

  expect(planned(updatesFor(policy, latest, nodeTags, 0))).toEqual([]);

  expect(
    planned(
      updatesFor(
        { ...policy, settings: { pinDigests: true } },
        latest,
        nodeTags,
        0,
      ),
    ),
  ).toEqual([["pinDigest", "latest", "latest", "sha256:latest"]]);
});

test("versionCompatibility compares the version and keeps the compatibility", () => {
  const compatibility: Policy = {
    ...policy,
    settings: {
      versioning: "node",
      versionCompatibility: "^(?<version>[^-]+)(?<compatibility>-.*)?$",
    },
  };

  expect(
    planned(
      updatesFor(
        compatibility,
        { ...node, currentValue: "22-alpine" },
        {
          releases: ["22-alpine", "24-alpine", "24", "26-bookworm"].map(
            (version) => ({ version }),
          ),
        },
        0,
      ),
    ),
  ).toEqual([["major", "22-alpine", "24-alpine", undefined]]);
});

test("open alerts on a package combine into its highest first patched version", () => {
  expect(
    vulnerabilities([
      { ecosystem: "npm", packageName: "astro", firstPatchedVersion: "7.3.0" },
      { ecosystem: "npm", packageName: "astro", firstPatchedVersion: "7.4.0" },
      { ecosystem: "npm", packageName: "astro", firstPatchedVersion: "7.2.12" },
      { ecosystem: "npm", packageName: "vite", firstPatchedVersion: undefined },
      { ecosystem: "swift", packageName: "x", firstPatchedVersion: "1.0.0" },
    ]),
  ).toEqual([
    { datasources: ["npm"], packageName: "astro", fixVersion: "7.4.0" },
  ]);
});

const alerted = (fixStrategy: "lowest" | "highest"): Policy => ({
  ...policy,
  rules: [
    { match: {}, set: { minimumReleaseAge: "14 days", groupName: "all" } },
  ],
  vulnerabilityAlerts: {
    settings: { groupName: null, minimumReleaseAge: null },
    fixStrategy,
  },
  vulnerabilities: [
    { datasources: ["npm"], packageName: "astro", fixVersion: "7.3.0" },
  ],
});

const fixReleases: Releases = {
  releases: ["7.2.10", "7.3.0", "7.3.1", "7.4.5", "8.0.0"].map((version) => ({
    version,
    date: "2026-11-07T00:00:00Z",
  })),
};

test("an alert bumps the range to its first fix on its own branch, past rules' release age and groups", () => {
  const updates = updatesFor(
    alerted("lowest"),
    astro,
    fixReleases,
    Date.parse("2026-11-08T00:00:00Z"),
  ).updates.map(({ updateType, from, to, branch, vulnerable }) => [
    updateType,
    from,
    to,
    branch,
    vulnerable,
  ]);

  expect(updates).toEqual([
    ["minor", "7.2.10", "7.3.0", "npm-astro-vulnerability", true],
  ]);
});

test("the highest fix strategy moves to the newest release", () => {
  const updates = updatesFor(
    alerted("highest"),
    astro,
    fixReleases,
    Date.parse("2026-11-08T00:00:00Z"),
  ).updates.map(({ to }) => to);

  expect(updates).toEqual(["8.0.0"]);
});

test("a range already starting at the fix isn't a vulnerability fix", () => {
  const updates = updatesFor(
    alerted("lowest"),
    { ...astro, currentValue: "^7.3.0" },
    fixReleases,
    Date.parse("2026-11-08T00:00:00Z"),
  ).updates;

  expect(updates.some(({ vulnerable }) => vulnerable === true)).toBe(false);
});

test("an alert on a locked range moves the lockfile to the fix", () => {
  const updates = updatesFor(
    alerted("lowest"),
    { ...astro, lockedVersion: "7.2.11" },
    fixReleases,
    Date.parse("2026-11-08T00:00:00Z"),
  ).updates.map(({ from, to, lockfile, branch }) => [
    from,
    to,
    lockfile,
    branch,
  ]);

  expect(updates).toEqual([
    ["7.2.11", "7.3.0", true, "npm-astro-vulnerability"],
  ]);
});
