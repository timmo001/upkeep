/** How Renovate configs merge and their presets resolve, as Renovate does it. */
import { expect, test } from "bun:test";
import { Effect, Option, Schema } from "effect";
import { mergeChildConfig, parsePreset, resolvePresets } from "./Renovate";
import type { ReadFile } from "./Updaters";

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
