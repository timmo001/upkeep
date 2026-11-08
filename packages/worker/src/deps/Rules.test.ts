/** How packageRules match and settle a dependency's settings, as Renovate does. */
import { expect, test } from "bun:test";
import type { Dependency, Policy, Rule } from "./Policy";
import { matchesPatterns, matchesRule, settingsFor } from "./Rules";

const dependency: Dependency = {
  manager: "bun",
  file: "packages/worker/package.json",
  lockFiles: ["bun.lock"],
  depName: "@effect/platform-bun",
  packageName: "@effect/platform-bun",
  datasource: "npm",
  depType: "dependencies",
  currentValue: "4.0.0-beta.40",
  sourceUrl: "https://github.com/Effect-TS/effect-smol",
};

const policy = (rules: ReadonlyArray<Rule>): Policy => ({
  updater: "renovate",
  updaterRuns: true,
  file: "renovate.json",
  settings: {},
  ignorePaths: [],
  enabledManagers: [],
  ignoreDeps: [],
  rules,
  customManagers: [],
  customDatasources: {},
  notes: [],
  unmodelled: [],
});

test("patterns take exact names, globs and regexes, any positive matching", () => {
  expect(matchesPatterns("@effect/vitest", ["@effect/**"])).toBe(true);
  expect(matchesPatterns("@effect/vitest", ["/^@effect\\//"])).toBe(true);
  expect(matchesPatterns("effect", ["Effect"])).toBe(true);
  expect(matchesPatterns("effect", ["typescript", "effect"])).toBe(true);
  expect(matchesPatterns("effect", [])).toBe(false);
});

test("every exclusion must hold, alone or beside positives", () => {
  expect(matchesPatterns("opencode-ai", ["!@timmo001/**"])).toBe(true);
  expect(matchesPatterns("@timmo001/oxlint", ["!@timmo001/**"])).toBe(false);
  expect(matchesPatterns("@effect/vitest", ["@effect/**", "!/vitest/"])).toBe(
    false,
  );
  expect(matchesPatterns("@effect/sql", ["@effect/**", "!/vitest/"])).toBe(
    true,
  );
});

test("a rule needs every matcher it gives, and one with none matches all", () => {
  expect(matchesRule({}, dependency)).toBe(true);
  expect(
    matchesRule(
      { managers: ["bun"], packageNames: ["@effect/**"] },
      dependency,
    ),
  ).toBe(true);
  expect(
    matchesRule(
      { managers: ["npm"], packageNames: ["@effect/**"] },
      dependency,
    ),
  ).toBe(false);
  expect(matchesRule({ categories: ["js"] }, dependency)).toBe(true);
  expect(
    matchesRule(
      { sourceUrls: ["https://github.com/Effect-TS/effect-smol{,/**}"] },
      dependency,
    ),
  ).toBe(true);
});

test("fileNames match the lockfile as well as the manifest", () => {
  expect(matchesRule({ fileNames: ["bun.lock"] }, dependency)).toBe(true);
  expect(matchesRule({ fileNames: ["packages/**"] }, dependency)).toBe(true);
  expect(matchesRule({ fileNames: ["docs/**"] }, dependency)).toBe(false);
});

test("a matcher whose value is missing never matches", () => {
  expect(matchesRule({ updateTypes: ["major"] }, dependency)).toBe(false);
  expect(
    matchesRule({ updateTypes: ["major"] }, dependency, {
      updateType: "major",
    }),
  ).toBe(true);
  expect(
    matchesRule(
      { sourceUrls: ["https://github.com/**"] },
      { ...dependency, sourceUrl: null },
    ),
  ).toBe(false);
});

test("currentValue and currentVersion read the version in use", () => {
  const python: Dependency = {
    ...dependency,
    manager: "custom.regex",
    depName: "python",
    currentValue: "3.12",
  };

  expect(matchesRule({ currentValue: "/^3\\./" }, python)).toBe(true);
  expect(
    matchesRule(
      { currentVersion: "<4" },
      { ...dependency, currentValue: "3.9.2" },
    ),
  ).toBe(true);
  expect(
    matchesRule(
      { currentVersion: ">=7" },
      { ...dependency, currentValue: "^5.9.0", lockedVersion: "5.9.3" },
    ),
  ).toBe(false);
});

test("later rules win, and a group without a slug drops an earlier slug", () => {
  const settings = settingsFor(
    policy([
      {
        match: { packageNames: ["@effect/**"] },
        set: { groupName: "Effect", groupSlug: "effect", automerge: true },
      },
      {
        match: { managers: ["bun"] },
        set: { groupName: "Bun packages", minimumReleaseAge: "1 day" },
      },
    ]),
    dependency,
  );

  expect(settings).toMatchObject({
    groupName: "Bun packages",
    groupSlug: null,
    automerge: true,
    minimumReleaseAge: "1 day",
  });
});

test("null clears what an earlier rule set", () => {
  const settings = settingsFor(
    policy([
      { match: {}, set: { minimumReleaseAge: "1 day" } },
      {
        match: { sourceUrls: ["https://github.com/Effect-TS/**"] },
        set: { minimumReleaseAge: null },
      },
    ]),
    dependency,
  );

  expect(settings.minimumReleaseAge).toBeNull();
});

test("rules with matchers Upkeep can't read never apply", () => {
  const settings = settingsFor(
    policy([
      { match: {}, set: { enabled: false }, unsupported: ["matchJsonata"] },
    ]),
    dependency,
  );

  expect(settings.enabled).toBe(true);
});

test("ignoreDeps disables a dependency whatever the rules say", () => {
  const settings = settingsFor(
    {
      ...policy([{ match: {}, set: { enabled: true } }]),
      ignoreDeps: ["@effect/platform-bun"],
    },
    dependency,
  );

  expect(settings.enabled).toBe(false);
});
