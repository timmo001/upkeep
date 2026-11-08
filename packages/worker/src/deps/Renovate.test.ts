/**
 * How Renovate configs merge, their presets resolve and they translate into
 * a Policy, as Renovate reads them.
 */
import { expect, test } from "bun:test";
import { Effect, Option, Schema } from "effect";
import { apply, Edit } from "./Applier";
import * as Managers from "./Managers";
import { group, updatesFor } from "./Planner";
import type { Dependency } from "./Policy";
import {
  mergeChildConfig,
  parsePreset,
  resolvePresets,
  toPolicy,
} from "./Renovate";
import { notesFor, settingsFor } from "./Rules";
import type { ReadFile } from "./Updaters";

const effect: Dependency = {
  manager: "npm",
  file: "package.json",
  depName: "effect",
  packageName: "effect",
  datasource: "npm",
  depType: "dependencies",
  currentValue: "4.0.0",
};

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

  const settings = settingsFor(policy, effect);

  expect(settings.automerge).toBe(true);

  const [only] = group(policy, [
    {
      dependency: effect,
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
  expect(notesFor(own, [])).toEqual([
    "not modelled: vulnerabilityAlerts.schedule",
  ]);
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
  expect(notesFor(policy, [effect]).join("\n")).not.toContain(
    "lockFileMaintenance",
  );
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

test("Dockerfiles, Compose files and workflow containers give their images", () => {
  const extraction = Effect.runSync(
    Managers.extract(
      toPolicy({}, "renovate.json", []),
      new Map([
        [
          "Dockerfile",
          [
            "# syntax=docker/dockerfile:1",
            "FROM --platform=$BUILDPLATFORM node:22-alpine AS build",
            "FROM build AS test",
            "FROM ${BASE}",
            "FROM ghcr.io/owner/tool:1.2.3@sha256:abc AS tool",
            "FROM scratch",
            "FROM localhost:5000/app",
          ].join("\n"),
        ],
        [
          "compose.yaml",
          "services:\n  db:\n    image: postgres:16.4\n  app:\n    build: .\n",
        ],
        [
          ".github/workflows/ci.yml",
          [
            "jobs:",
            "  build:",
            "    runs-on: ubuntu-latest",
            "    container: archlinux:latest@sha256:def",
            "    services:",
            "      redis:",
            "        image: redis:7",
            "    steps:",
            "      - uses: docker://alpine:3.20",
          ].join("\n"),
        ],
      ]),
    ),
  );

  expect(
    extraction.dependencies.map((dependency) => [
      dependency.manager,
      dependency.depType,
      dependency.depName,
      dependency.currentValue,
      dependency.currentDigest,
    ]),
  ).toEqual([
    ["dockerfile", "stage", "node", "22-alpine", undefined],
    ["dockerfile", "stage", "ghcr.io/owner/tool", "1.2.3", "sha256:abc"],
    ["dockerfile", "final", "localhost:5000/app", "", undefined],
    ["docker-compose", "image", "postgres", "16.4", undefined],
    ["github-actions", "container", "archlinux", "latest", "sha256:def"],
    ["github-actions", "service", "redis", "7", undefined],
    ["github-actions", "docker", "alpine", "3.20", undefined],
  ]);

  expect(extraction.notes).toEqual([
    "Dockerfile: image ${BASE} uses a variable",
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

  const npmRunAll = {
    manager: "npm",
    file: "package.json",
    depName: "npm-run-all",
    packageName: "npm-run-all",
    datasource: "npm",
    depType: "devDependencies",
    currentValue: "^4.1.5",
  };

  const settings = settingsFor(policy, npmRunAll);

  expect(settings.replacementName).toBe("npm-run-all2");
  expect(settings.replacementVersion).toBe("5.0.0");
  expect(notesFor(policy, [npmRunAll]).join("\n")).not.toMatch(
    /replacementName|replacementVersion\b/,
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

test("a rule is noted only when its other matchers find a dependency", () => {
  const policy = toPolicy(
    {
      packageRules: [
        {
          matchDatasources: ["docker"],
          matchPackageNames: ["php"],
          matchJsonata: ["true"],
          enabled: true,
          schedule: ["at any time"],
        },
        {
          matchPackageNames: ["effect"],
          matchUpdateTypes: ["major"],
          matchJsonata: ["true"],
          automerge: true,
          isVulnerabilityAlert: true,
        },
      ],
    },
    "renovate.json",
    [],
  );

  expect(notesFor(policy, [])).toEqual([]);
  expect(notesFor(policy, [effect])).toEqual([
    "a rule uses matchJsonata, so it never matches",
    "not modelled: packageRules.isVulnerabilityAlert",
  ]);
});

test("config for a Renovate manager Upkeep doesn't read is left out", () => {
  const policy = toPolicy(
    {
      nuget: { ignorePaths: ["**/tests/**"] },
      overrideDescription: "Only describes the preset",
      postUpgradeTasks: { commands: ["make"] },
    },
    "renovate.json",
    [],
  );

  expect(notesFor(policy, [])).toEqual(["not modelled: postUpgradeTasks"]);
});

test("replacementNameTemplate renders Renovate's replace helper, and an image moves to its replacement", async () => {
  expect(
    Managers.render("{{{replace 'o' '0' depName}}} {{depName}}", {
      depName: "foo",
    }),
  ).toBe("f00 foo");

  const { config } = await resolve({ extends: ["replacements:all"] });
  const policy = toPolicy(config, "renovate.json", []);

  const pause: Dependency = {
    manager: "dockerfile",
    file: "Dockerfile",
    depName: "k8s.gcr.io/pause",
    packageName: "k8s.gcr.io/pause",
    datasource: "docker",
    depType: "final",
    currentValue: "3.9",
  };

  const replace = (dependency: Dependency, text: string) => {
    const replacement = updatesFor(
      policy,
      dependency,
      { releases: [{ version: "3.9" }] },
      Date.now(),
    ).updates.find((update) => update.updateType === "replacement");

    return {
      newName: replacement?.newName,
      edit: replacement === undefined ? undefined : apply(replacement, text),
    };
  };

  expect(replace(pause, "FROM k8s.gcr.io/pause:3.9\n")).toMatchObject({
    newName: "registry.k8s.io/pause",
    edit: Edit.Edited({ text: "FROM registry.k8s.io/pause:3.9\n" }),
  });

  // A pinned image needs the replacement's own digest, which isn't looked up
  expect(
    replace(
      { ...pause, currentDigest: "sha256:abc" },
      "FROM k8s.gcr.io/pause:3.9@sha256:abc\n",
    ).edit?._tag,
  ).toBe("Unsupported");
});

test("$/ and ./ actions point into the repository, so they're skipped", () => {
  const extraction = Effect.runSync(
    Managers.extract(
      toPolicy({}, "renovate.json", []),
      new Map([
        [
          ".github/workflows/ci.yml",
          [
            "jobs:",
            "  build:",
            "    runs-on: ubuntu-latest",
            "    steps:",
            "      - uses: $/.github/actions/setup",
            "      - uses: ./.github/actions/build",
            "      - uses: actions/checkout@v5",
          ].join("\n"),
        ],
      ]),
    ),
  );

  expect(
    extraction.dependencies.map((dependency) => dependency.depName),
  ).toEqual(["actions/checkout"]);
  expect(extraction.notes).toEqual([]);
});

test("nested overrides are read as Renovate reads them and written in place", () => {
  const manifest = (overridden: string) =>
    `${JSON.stringify(
      {
        dependencies: { effect: "4.1.2" },
        overrides: {
          "@timmo001/effect-herdr": {
            effect: overridden,
            "@effect/platform-node-shared": "4.1.2",
          },
          foo: { ".": "1.0.0", bar: { baz: "2.0.0" } },
          semver: "$semver",
        },
      },
      null,
      2,
    )}\n`;

  const extraction = Effect.runSync(
    Managers.extract(
      toPolicy({}, "renovate.json", []),
      new Map([["package.json", manifest("4.1.2")]]),
    ),
  );

  expect(
    extraction.dependencies.map((dependency) => [
      dependency.depName,
      dependency.depType,
      dependency.currentValue,
    ]),
  ).toEqual([
    ["effect", "dependencies", "4.1.2"],
    ["effect", "overrides", "4.1.2"],
    ["@effect/platform-node-shared", "overrides", "4.1.2"],
    ["baz", "overrides", "2.0.0"],
  ]);
  expect(extraction.notes).toEqual([
    `package.json: the "." override for foo isn't read`,
  ]);

  const nested = extraction.dependencies[1];

  // The top-level effect at the same version stays as it is
  expect(
    nested === undefined
      ? undefined
      : apply(
          {
            dependency: nested,
            updateType: "patch",
            from: "4.1.2",
            to: "4.1.3",
            settings: {},
            branch: "effect",
            lockfile: false,
          },
          manifest("4.1.2"),
        ),
  ).toMatchObject(Edit.Edited({ text: manifest("4.1.3") }));
});
