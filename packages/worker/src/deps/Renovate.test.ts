/**
 * How Renovate configs merge, their presets resolve and they translate into
 * a Policy, as Renovate reads them.
 */
import { expect, test } from "bun:test";
import { Effect, Option, Schema } from "effect";
import * as Managers from "./Managers";
import { group } from "./Planner";
import {
  mergeChildConfig,
  parsePreset,
  resolvePresets,
  toPolicy,
} from "./Renovate";
import { settingsFor } from "./Rules";
import type { ReadFile } from "./Updaters";

test("enabled: false turns Renovate off but keeps its rules, and Upkeep owns automerged groups", () => {
  const policy = toPolicy(
    {
      enabled: false,
      packageRules: [{ matchPackageNames: ["*"], automerge: true }],
    },
    "renovate.json",
    [],
  );

  expect(policy.updaterRuns).toBe(false);
  expect(policy.settings.enabled).toBeUndefined();

  const dependency = {
    manager: "npm",
    file: "package.json",
    depName: "effect",
    packageName: "effect",
    datasource: "npm",
    depType: "dependencies",
    currentValue: "4.0.0",
  };

  const settings = settingsFor(policy, dependency);

  expect(settings.automerge).toBe(true);

  const [only] = group(policy, [
    {
      dependency,
      updateType: "patch",
      from: "4.0.0",
      to: "4.0.1",
      settings,
      branch: "effect-4.x",
      lockfile: false,
    },
  ]);

  expect(only?.owner).toBe("upkeep");
});

test("lock file maintenance is off by default, weekly once on, and its schedule sets how often", () => {
  const maintenance = (config: Schema.JsonObject) =>
    toPolicy(config, "renovate.json", []).maintenance;

  expect(maintenance({})).toBeUndefined();
  expect(maintenance({ lockFileMaintenance: { enabled: true } })).toEqual({
    automerge: false,
    everyDays: 7,
  });

  const every = (schedule: Schema.Json) =>
    maintenance({ lockFileMaintenance: { enabled: true, schedule } })
      ?.everyDays;

  expect(every(["before 4am on the first day of the month"])).toBe(30);
  expect(every(["* 0-3 1 * *"])).toBe(30);
  expect(every(["* 0-3 * * 1"])).toBe(7);
  expect(every("before 4am on monday")).toBe(7);
  expect(every(["before 4am"])).toBe(1);
  expect(every(["at any time"])).toBe(1);
  expect(every(["every weekday", "on the first day of the month"])).toBe(1);
});

test("vulnerability alerts are on by default, force Renovate's settings, and note a schedule", () => {
  const translate = (config: Schema.JsonObject) =>
    toPolicy(config, "renovate.json", []);

  expect(translate({}).vulnerabilityAlerts).toEqual({
    settings: {
      groupName: null,
      minimumReleaseAge: null,
      rangeStrategy: "update-lockfile",
    },
    fixStrategy: "lowest",
  });
  expect(translate({}).notes).toEqual([]);

  expect(
    translate({ vulnerabilityAlerts: { enabled: false } }).vulnerabilityAlerts,
  ).toBeUndefined();

  const own = translate({
    vulnerabilityAlerts: {
      automerge: true,
      vulnerabilityFixStrategy: "highest",
      schedule: ["before 4am"],
    },
  });

  expect(own.vulnerabilityAlerts?.settings.automerge).toBe(true);
  expect(own.vulnerabilityAlerts?.fixStrategy).toBe("highest");
  expect(own.notes).toEqual(["not modelled: vulnerabilityAlerts.schedule"]);
});

test("a rule on the lockFileMaintenance update type alone turns it on or automerges it", () => {
  const policy = toPolicy(
    {
      automerge: false,
      lockFileMaintenance: { enabled: true },
      packageRules: [
        { matchUpdateTypes: ["lockFileMaintenance"], automerge: true },
        {
          matchUpdateTypes: ["lockFileMaintenance"],
          matchManagers: ["npm"],
          enabled: false,
        },
      ],
    },
    "renovate.json",
    [],
  );

  expect(policy.maintenance).toEqual({ automerge: true, everyDays: 7 });
  expect(policy.notes.join("\n")).not.toContain("lockFileMaintenance");
});

test("submodules stay off until the config turns them on, as in Renovate", () => {
  const submodule = {
    manager: "git-submodules",
    file: ".gitmodules",
    depName: "plugins/clock",
    packageName: "https://github.com/owner/clock.git",
    datasource: "git-refs",
    depType: "submodule",
    currentValue: "main",
  };

  expect(
    settingsFor(toPolicy({}, "renovate.json", []), submodule).enabled,
  ).toBe(false);

  expect(
    settingsFor(
      toPolicy({ "git-submodules": { enabled: true } }, "renovate.json", []),
      submodule,
    ).enabled,
  ).toBe(true);
});

test("custom datasources are read with Renovate's json default", () => {
  const policy = toPolicy(
    {
      customDatasources: {
        mise: {
          defaultRegistryUrlTemplate: "https://example.com/PKGBUILD",
          format: "plain",
          transformTemplates: ["$"],
        },
        quickshell: { defaultRegistryUrlTemplate: "https://example.com/json" },
      },
    },
    "renovate.json",
    [],
  );

  expect(policy.customDatasources).toEqual({
    mise: {
      registryUrlTemplate: "https://example.com/PKGBUILD",
      format: "plain",
      transformTemplates: ["$"],
    },
    quickshell: {
      registryUrlTemplate: "https://example.com/json",
      format: "json",
      transformTemplates: [],
    },
  });
});

test("submodules are read from .gitmodules with the commits the tree pins", () => {
  const extraction = Effect.runSync(
    Managers.extract(
      toPolicy({ "git-submodules": { enabled: true } }, "renovate.json", []),
      new Map([
        [
          ".gitmodules",
          '[submodule "clock"]\n\tpath = plugins/clock\n\turl = https://github.com/owner/clock.git\n\tbranch = dev\n[submodule "notes"]\n\tpath = plugins/notes\n\turl = https://github.com/owner/notes.git\n',
        ],
      ]),
      new Map([
        ["plugins/clock", "a".repeat(40)],
        ["plugins/notes", "b".repeat(40)],
      ]),
    ),
  );

  expect(
    extraction.dependencies.map((dependency) => [
      dependency.depName,
      dependency.packageName,
      dependency.currentValue,
      dependency.currentDigest,
    ]),
  ).toEqual([
    [
      "plugins/clock",
      "https://github.com/owner/clock.git",
      "dev",
      "a".repeat(40),
    ],
    [
      "plugins/notes",
      "https://github.com/owner/notes.git",
      "HEAD",
      "b".repeat(40),
    ],
  ]);
});

test("package.json dependencies take the version their nearest lockfile locks", () => {
  const extraction = Effect.runSync(
    Managers.extract(
      toPolicy({}, "renovate.json", []),
      new Map([
        [
          "packages/a/package.json",
          JSON.stringify({
            dependencies: { semver: "^7.5.0", old: "npm:semver@^6.0.0" },
            peerDependencies: { semver: "^7.0.0" },
          }),
        ],
        [
          "package-lock.json",
          JSON.stringify({
            lockfileVersion: 3,
            packages: {
              "node_modules/semver": { version: "7.6.0" },
              "node_modules/old": { version: "6.3.1" },
            },
          }),
        ],
        ["tools/package.json", JSON.stringify({ dependencies: { a: "^1" } })],
        ["tools/bun.lock", "{ not json"],
      ]),
    ),
  );

  expect(
    extraction.dependencies.map((dependency) => [
      dependency.manager,
      dependency.depName,
      dependency.depType,
      dependency.lockFiles,
      dependency.lockedVersion,
    ]),
  ).toEqual([
    ["npm", "semver", "dependencies", ["package-lock.json"], "7.6.0"],
    ["npm", "old", "dependencies", ["package-lock.json"], undefined],
    ["npm", "semver", "peerDependencies", ["package-lock.json"], undefined],
    ["bun", "a", "dependencies", ["tools/bun.lock"], undefined],
  ]);
  expect(extraction.notes).toHaveLength(1);
  expect(extraction.notes[0]).toStartWith(
    "tools/bun.lock couldn't be read, so its locked versions aren't known",
  );
});

test("mergeable arrays concatenate and objects merge, other keys replace", () => {
  const merged = mergeChildConfig(
    {
      packageRules: [{ groupName: "a" }],
      major: { automerge: false, labels: ["major"] },
      labels: ["deps"],
      minimumReleaseAge: "1 day",
    },
    {
      packageRules: [{ groupName: "b" }],
      major: { automerge: true },
      labels: ["mine"],
    },
  );

  expect(merged).toEqual({
    packageRules: [{ groupName: "a" }, { groupName: "b" }],
    major: { automerge: true, labels: ["major"] },
    labels: ["mine"],
    minimumReleaseAge: "1 day",
  });
});

test("force wins over everything merged under it", () => {
  expect(
    mergeChildConfig({ automerge: true }, { force: { automerge: false } }),
  ).toMatchObject({ automerge: false });
});

test("preset names parse as Renovate's presets/parse.ts does", () => {
  expect(parsePreset("github>timmo001/renovate-config").parsed).toEqual({
    source: "github",
    repo: "timmo001/renovate-config",
    path: undefined,
    name: "default",
    tag: undefined,
  });
  expect(parsePreset("github>owner/repo//presets/node#v2").parsed).toEqual({
    source: "github",
    repo: "owner/repo",
    path: "presets",
    name: "node",
    tag: "v2",
  });
  expect(parsePreset("local>owner/repo:fast").parsed).toMatchObject({
    repo: "owner/repo",
    name: "fast",
  });
  expect(parsePreset(":semanticCommits").parsed).toEqual({
    source: "internal",
    namespace: "default",
    name: "semanticCommits",
  });
  expect(parsePreset("npm>some-preset").parsed.source).toBe("unsupported");
});

const files = new Map([
  [
    "timmo001/shared:default.json",
    JSON.stringify({
      extends: ["group:monorepos", "github>timmo001/shared:fast"],
      minimumReleaseAge: "1 day",
      packageRules: [{ matchPackageNames: ["effect"], groupName: "Effect" }],
    }),
  ],
  [
    "timmo001/shared:fast.json",
    JSON.stringify({
      minimumReleaseAge: "2 hours",
      packageRules: [
        { matchPackageNames: ["bun"], minimumReleaseAge: "1 hour" },
      ],
    }),
  ],
]);

const readFile: ReadFile = (repo, path) =>
  Effect.succeed(Option.fromNullishOr(files.get(`${repo}:${path}`)));

const resolve = (config: Schema.JsonObject) =>
  Effect.runPromise(resolvePresets(config, readFile, "timmo001"));

const packageRules = Schema.decodeUnknownSync(Schema.Array(Schema.JsonObject));

test("presets merge in order, then the config itself on top", async () => {
  const { config, unknown } = await resolve({
    extends: ["github>timmo001/shared", "npm>nothing"],
    packageRules: [
      { matchPackageNames: ["typescript"], allowedVersions: "<7" },
    ],
  });

  expect(unknown).toEqual(["npm>nothing"]);
  expect(config.minimumReleaseAge).toBe("1 day");
  expect(config.extends).toBeUndefined();

  const rules = packageRules(config.packageRules);

  // The fast preset's rule comes first, as it was extended before the
  // shared preset's own rules were merged over it
  expect(rules.at(-3)).toEqual({
    matchPackageNames: ["bun"],
    minimumReleaseAge: "1 hour",
  });
  expect(rules.at(-2)).toEqual({
    matchPackageNames: ["effect"],
    groupName: "Effect",
  });
  expect(rules.at(-1)).toEqual({
    matchPackageNames: ["typescript"],
    allowedVersions: "<7",
  });
  // group:monorepos brings its monorepo rules in ahead of them
  expect(rules.length).toBeGreaterThan(3);
});

test("replacements:all names a dependency's replacement and isn't left out", async () => {
  const { config } = await resolve({ extends: ["replacements:all"] });
  const policy = toPolicy(config, "renovate.json", []);

  const settings = settingsFor(policy, {
    manager: "npm",
    file: "package.json",
    depName: "npm-run-all",
    packageName: "npm-run-all",
    datasource: "npm",
    depType: "devDependencies",
    currentValue: "^4.1.5",
  });

  expect(settings.replacementName).toBe("npm-run-all2");
  expect(settings.replacementVersion).toBe("5.0.0");
  expect(policy.notes.join("\n")).not.toMatch(
    /replacementName\b|replacementVersion\b/,
  );
});

test("ignorePresets leaves a preset out wherever it's extended", async () => {
  const { config } = await resolve({
    extends: ["github>timmo001/shared", "github>timmo001/shared:fast"],
    ignorePresets: ["group:monorepos"],
  });

  const rules = packageRules(config.packageRules);

  // fast is merged twice, as Renovate does, so it ends on top
  expect(config.minimumReleaseAge).toBe("2 hours");
  expect(rules).toHaveLength(3);
});

test("presets inside packageRules resolve too", async () => {
  const { config } = await resolve({
    packageRules: [
      {
        extends: ["monorepo:effect"],
        groupName: "Effect",
        groupSlug: "effect",
      },
    ],
  });

  const [rule] = packageRules(config.packageRules);

  expect(rule?.matchSourceUrls).toContain(
    "https://github.com/Effect-TS/effect-smol",
  );
  expect(rule?.groupSlug).toBe("effect");
});
