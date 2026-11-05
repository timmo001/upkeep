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
