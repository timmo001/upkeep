/**
 * The Renovate adapter: find a repository's Renovate config, resolve the
 * presets it extends the way Renovate does, and translate the result into
 * Upkeep's Policy. Renovate itself never runs: shared presets are fetched
 * from GitHub and built-in ones read from renovate-presets.json, a snapshot
 * of Renovate's own presets.
 */
import { EventJobs } from "@upkeep/api";
import { Effect, Option, Predicate, Result, Schema } from "effect";
import builtIn from "./renovate-presets.json" with { type: "json" };
import {
  type CustomDatasource,
  type CustomManager,
  DepsError,
  type Maintenance,
  Patterns,
  type Policy,
  type Rule,
  Settings,
  UpdateType,
  type VulnerabilityAlerts,
} from "./Policy";

/** A Renovate config or preset, as the JSON it's written in. */
type Config = Schema.JsonObject;

type Json = Schema.Json;

/** Reads a file from a GitHub repository, none when it isn't there. */
export type ReadFile = (
  repo: string,
  path: string,
  ref?: string,
) => Effect.Effect<Option.Option<string>, DepsError>;

/**
 * Where Renovate looks for a repository's config, in its order. Shared with
 * the server, which starts `deps` when a push changes one.
 */
export const configFiles = EventJobs.renovateConfigFiles;

/** Renovate's options that merge with a parent's rather than replace it. */
const mergeableArrays = new Set([
  "description",
  "ignoreDeps",
  "packageRules",
  "customManagers",
  "hostRules",
  "addLabels",
  "additionalReviewers",
  "managerFilePatterns",
  "postUpdateOptions",
  "prBodyNotes",
  "suppressNotifications",
  "commitTrailers",
  "matchCategories",
  "matchRepositories",
  "matchBaseBranches",
  "matchManagers",
  "matchDatasources",
  "matchDepTypes",
  "matchPackageNames",
  "matchDepNames",
  "matchSourceUrls",
  "matchRegistryUrls",
  "matchConfidence",
  "matchUpdateTypes",
  "matchJsonata",
]);

const mergeableObjects = new Set([
  "force",
  "customDatasources",
  "registryAliases",
  "major",
  "minor",
  "patch",
  "pin",
  "digest",
  "pinDigest",
  "rollback",
  "replacement",
  "vulnerabilityAlerts",
  "lockFileMaintenance",
  "group",
  "constraints",
  "prBodyDefinitions",
  "prBodyHeadingDefinitions",
  "constraintsVersioning",
]);

const isConfig = (value: Json | undefined): value is Config =>
  Predicate.isObject(value) && !Array.isArray(value);

const isList = (value: Json | undefined): value is Schema.JsonArray =>
  Array.isArray(value);

/**
 * Renovate's mergeChildConfig: the child's keys replace the parent's, except
 * mergeable ones, where arrays are concatenated and objects merged in turn.
 */
export const mergeChildConfig = (parent: Config, child: Config): Config => {
  const merged: Config = Object.fromEntries(
    [...Object.entries(parent), ...Object.entries(child)].map(
      ([key, entry]): [string, Json] => {
        const inherited = parent[key];
        const own = child[key];
        const value = own === undefined ? (inherited ?? entry) : own;

        if (own === undefined || inherited === undefined || !own || !inherited)
          return [key, value];

        if (mergeableArrays.has(key) && isList(inherited) && isList(own))
          return [key, [...inherited, ...own]];

        if (mergeableObjects.has(key) && isConfig(inherited) && isConfig(own))
          return [key, mergeChildConfig(inherited, own)];

        return [key, value];
      },
    ),
  );

  const force = merged.force;

  return isConfig(force)
    ? Object.fromEntries([
        ...Object.entries(merged),
        ...Object.entries(force).filter(
          (pair): pair is [string, Json] => pair[1] !== undefined,
        ),
      ])
    : merged;
};

/** Renovate's built-in presets, by namespace then name. */
const builtInPresets = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.JsonObject),
)(builtIn.groups);

/** Renovate's built-in preset namespaces, such as `config:` and `group:`. */
const namespaces = new Set(Object.keys(builtInPresets));

type Parsed =
  | {
      readonly source: "internal";
      readonly namespace: string;
      readonly name: string;
    }
  | {
      readonly source: "github";
      readonly repo: string;
      readonly path: string | undefined;
      readonly name: string;
      readonly tag: string | undefined;
    }
  | { readonly source: "unsupported" };

interface Preset {
  readonly parsed: Parsed;
  readonly params: ReadonlyArray<string>;
}

/** Parse an `extends` entry, following Renovate's presets/parse.ts. */
export const parsePreset = (input: string): Preset => {
  const paren = input.indexOf("(");

  const params =
    paren === -1
      ? []
      : input
          .slice(paren + 1, -1)
          .split(",")
          .map((param) => param.trim());

  const name = paren === -1 ? input : input.slice(0, paren);
  const prefix = /^(?<source>github|local)>(?<rest>.*)$/.exec(name)?.groups;

  if (prefix !== undefined) {
    const rest = prefix.rest ?? "";

    const subdir =
      /^(?<repo>[\w\-. /%]+?)\/\/(?:(?<path>[\w\-./]+)\/)?(?<name>[\w\-.]+)(?:#(?<tag>[\w\-./]+?))?$/.exec(
        rest,
      )?.groups;

    const plain =
      /^(?<repo>[\w\-. /%]+)(?::(?<name>[\w\-.+/]+))?(?:#(?<tag>[\w\-./]+?))?$/.exec(
        rest,
      )?.groups;

    const groups = subdir ?? plain;

    if (groups?.repo === undefined)
      return { parsed: { source: "unsupported" }, params };

    return {
      parsed: {
        source: "github",
        repo: groups.repo,
        path: subdir?.path,
        name: groups.name ?? "default",
        tag: groups.tag,
      },
      params,
    };
  }

  if (name.startsWith(":"))
    return {
      parsed: { source: "internal", namespace: "default", name: name.slice(1) },
      params,
    };

  const [namespace = "", ...rest] = name.split(":");

  if (rest.length > 0 && namespaces.has(namespace))
    return {
      parsed: { source: "internal", namespace, name: rest.join(":") },
      params,
    };

  return { parsed: { source: "unsupported" }, params };
};

/** Fill `{{arg0}}` and `{{args}}` in a preset with its parameters. */
const replaceArgs = (value: Json, args: ReadonlyMap<string, string>): Json => {
  if (Predicate.isString(value))
    return [...args].reduce(
      (text, [arg, replacement]) => text.replaceAll(`{{${arg}}}`, replacement),
      value,
    );

  if (isList(value)) return value.map((item) => replaceArgs(item, args));

  if (isConfig(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceArgs(item, args),
      ]),
    );

  return value;
};

const parseConfig = (text: string, file: string) =>
  Effect.try({
    try: () => Bun.JSON5.parse(text),
    catch: (cause) =>
      new DepsError({ message: `${file} isn't valid JSON: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(Schema.JsonObject)(value).pipe(
        Effect.mapError(
          () => new DepsError({ message: `${file} isn't an object` }),
        ),
      ),
    ),
  );

/** Load one preset's config, before its own `extends` are resolved. */
const loadPreset = Effect.fnUntraced(function* (
  preset: string,
  readFile: ReadFile,
  host: string,
): Effect.fn.Return<Option.Option<Config>, DepsError> {
  const { parsed, params } = parsePreset(preset);
  let config: Option.Option<Config> = Option.none();

  if (parsed.source === "internal") {
    const found = builtInPresets[parsed.namespace]?.[parsed.name];

    config = isConfig(found) ? Option.some(found) : Option.none();
  } else if (parsed.source === "github") {
    const repo = parsed.repo.includes("/")
      ? parsed.repo
      : `${host}/${parsed.repo}`;

    const directory = parsed.path === undefined ? "" : `${parsed.path}/`;

    const names = /\.json5?$/.test(parsed.name)
      ? [parsed.name]
      : parsed.name === "default"
        ? ["default.json", "renovate.json"]
        : [`${parsed.name}.json`];

    for (const name of names) {
      const text = yield* readFile(repo, `${directory}${name}`, parsed.tag);

      if (Option.isSome(text)) {
        config = Option.some(yield* parseConfig(text.value, `${repo}:${name}`));

        break;
      }
    }
  }

  if (Option.isNone(config) || params.length === 0) return config;

  const args = new Map([
    ["args", params.join(", ")],
    ...params.map((param, index): [string, string] => [`arg${index}`, param]),
  ]);

  const replaced = replaceArgs(config.value, args);

  return isConfig(replaced) ? Option.some(replaced) : Option.none();
});

/** The result of resolving presets, with the ones that couldn't be read. */
export interface Resolved {
  readonly config: Config;
  readonly unknown: ReadonlyArray<string>;
}

/**
 * Renovate's resolveConfigPresets: merge each preset of `extends`, resolved
 * in turn, left to right, then the config itself on top, then resolve the
 * presets of nested objects and of objects in arrays such as packageRules.
 */
export const resolvePresets = Effect.fnUntraced(function* (
  input: Config,
  readFile: ReadFile,
  host: string,
  seen: ReadonlyArray<string> = [],
  ignored: Schema.JsonArray = [],
): Effect.fn.Return<Resolved, DepsError> {
  const unknown: Array<string> = [];
  const own = input.ignorePresets;
  // A config's ignorePresets hold for every preset under it
  const ignore = isList(own) ? own : ignored;
  const presets = isList(input.extends) ? input.extends : [];
  let merged: Config = {};

  for (const preset of presets) {
    if (!Predicate.isString(preset)) continue;

    if (seen.includes(preset) || ignore.includes(preset)) continue;

    const loaded = yield* loadPreset(preset, readFile, host);

    if (Option.isNone(loaded)) {
      unknown.push(preset);

      continue;
    }

    const resolved = yield* resolvePresets(
      loaded.value,
      readFile,
      host,
      [...seen, preset],
      ignore,
    );

    unknown.push(...resolved.unknown);
    merged = mergeChildConfig(merged, resolved.config);
  }

  const nested = (value: Json): Effect.Effect<Json, DepsError> =>
    isConfig(value)
      ? resolvePresets(value, readFile, host, seen, ignore).pipe(
          Effect.map((resolved) => {
            unknown.push(...resolved.unknown);

            return resolved.config;
          }),
        )
      : Effect.succeed(value);

  const entries = yield* Effect.forEach(
    Object.entries(mergeChildConfig(merged, input)).filter(
      ([key]) => key !== "extends" && key !== "ignorePresets",
    ),
    ([key, value]): Effect.Effect<readonly [string, Json], DepsError> => {
      if (isList(value))
        return Effect.forEach(value, nested).pipe(
          Effect.map((items) => [key, items] as const),
        );

      if (key === "onboardingConfig") return Effect.succeed([key, value]);

      return nested(value).pipe(Effect.map((config) => [key, config] as const));
    },
  );

  return {
    config: Object.fromEntries(entries),
    unknown: [...new Set(unknown)],
  };
});

/** Matchers Upkeep evaluates, as Renovate writes them in a packageRule. */
const PackageRule = Schema.Struct({
  description: Schema.optional(Schema.Union([Schema.String, Patterns])),
  matchManagers: Schema.optional(Patterns),
  matchDatasources: Schema.optional(Patterns),
  matchDepTypes: Schema.optional(Patterns),
  matchPackageNames: Schema.optional(Patterns),
  matchDepNames: Schema.optional(Patterns),
  matchFileNames: Schema.optional(Patterns),
  matchSourceUrls: Schema.optional(Patterns),
  matchUpdateTypes: Schema.optional(Patterns),
  matchCategories: Schema.optional(Patterns),
  matchRepositories: Schema.optional(Patterns),
  matchBaseBranches: Schema.optional(Patterns),
  matchCurrentValue: Schema.optional(Schema.String),
  matchCurrentVersion: Schema.optional(Schema.String),
});

const knownMatchers = new Set(
  Object.keys(PackageRule.fields).filter((key) => key.startsWith("match")),
);

/** A custom manager, as Renovate writes it. */
const RenovateManager = Schema.Struct({
  customType: Schema.String,
  description: Schema.optional(Schema.Union([Schema.String, Patterns])),
  managerFilePatterns: Schema.optional(Patterns),
  fileMatch: Schema.optional(Patterns),
  matchStrings: Schema.optional(Patterns),
  matchStringsStrategy: Schema.optional(Schema.String),
  fileFormat: Schema.optional(Schema.String),
  depNameTemplate: Schema.optional(Schema.String),
  packageNameTemplate: Schema.optional(Schema.String),
  datasourceTemplate: Schema.optional(Schema.String),
  depTypeTemplate: Schema.optional(Schema.String),
  currentValueTemplate: Schema.optional(Schema.String),
  versioningTemplate: Schema.optional(Schema.String),
  extractVersionTemplate: Schema.optional(Schema.String),
});

/** Settings Upkeep models, read as Renovate writes them. */
const settingKeys = new Set(Object.keys(Settings.fields));

/**
 * Keys that only shape Renovate's pull requests, commits, labels or
 * dashboard, so what gets updated doesn't depend on them.
 */
const presentation = new Set([
  "$schema",
  "description",
  "dependencyDashboard",
  "dependencyDashboardApproval",
  "dependencyDashboardAutoclose",
  "dependencyDashboardHeader",
  "dependencyDashboardFooter",
  "dependencyDashboardLabels",
  "dependencyDashboardTitle",
  "labels",
  "addLabels",
  "assignees",
  "reviewers",
  "additionalReviewers",
  "automergeStrategy",
  "automergeType",
  "platformAutomerge",
  "commitMessage",
  "commitMessageAction",
  "commitMessageExtra",
  "commitMessagePrefix",
  "commitMessageSuffix",
  "commitMessageTopic",
  "commitBody",
  "semanticCommits",
  "semanticCommitScope",
  "semanticCommitType",
  "prTitle",
  "prHeader",
  "prFooter",
  "prBodyColumns",
  "prBodyDefinitions",
  "prBodyNotes",
  "prBodyTemplate",
  "changelogUrl",
  "sourceUrl",
  "sourceDirectory",
  "homepage",
  "timezone",
  "prCreation",
  "prConcurrentLimit",
  "prHourlyLimit",
  "branchConcurrentLimit",
  "rebaseWhen",
  "recreateWhen",
  "internalChecksFilter",
  "configMigration",
]);

const strings = (value: Json | undefined) =>
  Predicate.isString(value)
    ? [value]
    : isList(value)
      ? value.filter(Predicate.isString)
      : [];

const describe = (description: string | ReadonlyArray<string> | undefined) =>
  Predicate.isString(description) ? description : description?.join(" ");

const decodeSettings = Schema.decodeUnknownOption(Settings);

/** Translate a rule's own settings, listing the ones Upkeep doesn't model. */
const translateSettings = (config: Config) => {
  const ignored = Object.keys(config).filter(
    (key) =>
      !settingKeys.has(key) &&
      !key.startsWith("match") &&
      !key.startsWith("exclude") &&
      !presentation.has(key),
  );

  const set = decodeSettings(config);

  if (Option.isNone(set)) ignored.push("settings of an unexpected type");

  return { set: Option.getOrElse(set, () => ({})), ignored };
};

const decodeRule = Schema.decodeUnknownOption(PackageRule);

/** Translate one packageRule, with the settings Upkeep doesn't model. */
const translateRule = (config: Config) => {
  const unsupported = Object.keys(config).filter(
    (key) =>
      (key.startsWith("match") || key.startsWith("exclude")) &&
      !knownMatchers.has(key),
  );

  const decoded = decodeRule(config);

  if (Option.isNone(decoded))
    unsupported.push("matchers of an unexpected type");

  const rule = Option.getOrElse(decoded, () => PackageRule.make({}));
  const { set, ignored } = translateSettings(config);

  return {
    rule: {
      description: describe(rule.description),
      match: {
        managers: rule.matchManagers,
        datasources: rule.matchDatasources,
        depTypes: rule.matchDepTypes,
        packageNames: rule.matchPackageNames,
        depNames: rule.matchDepNames,
        fileNames: rule.matchFileNames,
        sourceUrls: rule.matchSourceUrls,
        updateTypes: rule.matchUpdateTypes,
        categories: rule.matchCategories,
        repositories: rule.matchRepositories,
        baseBranches: rule.matchBaseBranches,
        currentValue: rule.matchCurrentValue,
        currentVersion: rule.matchCurrentVersion,
      },
      set,
      unsupported: unsupported.length > 0 ? unsupported : undefined,
    } satisfies Rule,
    ignored,
  };
};

const decodeManager = Schema.decodeUnknownOption(RenovateManager);

/** Translate a custom manager, or say why it can't be. */
const translateManager = (
  config: Config,
): Result.Result<CustomManager, string> => {
  const decoded = decodeManager(config);

  if (Option.isNone(decoded))
    return Result.fail("a custom manager couldn't be read");

  const manager = decoded.value;

  const files = [
    ...(manager.managerFilePatterns ?? []),
    ...(manager.fileMatch ?? []).map((pattern) => `/${pattern}/`),
  ];

  const patterns = manager.matchStrings ?? [];
  const description = describe(manager.description);

  const templates = {
    depName: manager.depNameTemplate,
    packageName: manager.packageNameTemplate,
    datasource: manager.datasourceTemplate,
    depType: manager.depTypeTemplate,
    currentValue: manager.currentValueTemplate,
    versioning: manager.versioningTemplate,
    extractVersion: manager.extractVersionTemplate,
  };

  if (manager.customType === "regex") {
    const strategy = manager.matchStringsStrategy ?? "any";

    if (
      strategy !== "any" &&
      strategy !== "recursive" &&
      strategy !== "combination"
    )
      return Result.fail(
        `a regex custom manager has an unknown strategy ${strategy}`,
      );

    return Result.succeed({
      type: "regex",
      description,
      files,
      patterns,
      strategy,
      templates,
    });
  }

  if (manager.customType === "jsonata")
    return Result.succeed({
      type: "jsonata",
      description,
      files,
      patterns,
      format: manager.fileFormat ?? "json",
      templates,
    });

  return Result.fail(
    `a custom manager of type ${manager.customType} isn't supported`,
  );
};

/** The managers Upkeep reads, by Renovate name. */
export const managers = [
  "npm",
  "bun",
  "mise",
  "github-actions",
  "git-submodules",
  "dockerfile",
  "docker-compose",
];

/** A custom datasource, as Renovate writes it. */
const RenovateDatasource = Schema.Struct({
  defaultRegistryUrlTemplate: Schema.optional(Schema.String),
  format: Schema.optional(Schema.String),
  transformTemplates: Schema.optional(Patterns),
});

const decodeDatasource = Schema.decodeUnknownOption(RenovateDatasource);

/** Translate the custom datasources, noting any that can't be read. */
const translateDatasources = (value: Json | undefined) => {
  const datasources: Record<string, CustomDatasource> = {};
  const notes: Array<string> = [];

  for (const [name, entry] of Object.entries(isConfig(value) ? value : {})) {
    const decoded = decodeDatasource(entry);

    if (Option.isNone(decoded)) {
      notes.push(`the custom datasource ${name} couldn't be read`);

      continue;
    }

    datasources[name] = {
      registryUrlTemplate: decoded.value.defaultRegistryUrlTemplate,
      format: decoded.value.format ?? "json",
      transformTemplates: decoded.value.transformTemplates ?? [],
    };
  }

  return { datasources, notes };
};

/** How many days apart one Renovate schedule entry, cron or text, comes round. */
const scheduleDays = (entry: string) => {
  const fields = entry.trim().split(/\s+/);

  if (
    fields.length === 5 &&
    fields.every((field) => /^[\d*,\-/]+$/.test(field))
  ) {
    if (fields[2] !== "*") return 30;

    return fields[4] === "*" ? 1 : 7;
  }

  const text = entry.toLowerCase();

  if (text.includes("month")) return 30;

  if (/weekday|any ?time|every ?day|daily/.test(text)) return 1;

  return /week|(?:mon|tues|wednes|thurs|fri|satur|sun)day/.test(text) ? 7 : 1;
};

/**
 * Lock file maintenance as the config sets it: its own object, then rules
 * that match only its update type, such as one that automerges it. Renovate
 * leaves it off, and runs it before 4am on Mondays.
 */
const translateMaintenance = (
  config: Config,
  rules: ReadonlyArray<Rule>,
  automerge: boolean | undefined,
): Maintenance | undefined => {
  const own = isConfig(config.lockFileMaintenance)
    ? config.lockFileMaintenance
    : {};

  const set: Settings = rules
    .filter(
      (rule) =>
        rule.unsupported === undefined &&
        rule.match.updateTypes?.includes("lockFileMaintenance") === true &&
        Object.entries(rule.match).every(
          ([key, value]) => key === "updateTypes" || value === undefined,
        ),
    )
    .reduce<Settings>((settings, rule) => ({ ...settings, ...rule.set }), {
      ...translateSettings(own).set,
    });

  if (set.enabled !== true) return undefined;

  const schedule = strings(own.schedule);

  return {
    automerge: set.automerge ?? automerge ?? false,
    everyDays:
      schedule.length === 0 ? 7 : Math.min(...schedule.map(scheduleDays)),
  };
};

/** Renovate's `vulnerabilityAlerts` defaults, which a config merges over. */
const vulnerabilityDefaults = {
  groupName: null,
  schedule: [],
  dependencyDashboardApproval: false,
  minimumReleaseAge: null,
  rangeStrategy: "update-lockfile",
  commitMessageSuffix: "[SECURITY]",
  branchTopic: "{{{datasource}}}-{{{depNameSanitized}}}-vulnerability",
  prCreation: "immediate",
  vulnerabilityFixStrategy: "lowest",
  prConcurrentLimit: 0,
} satisfies Config;

/**
 * Vulnerability alerts as the config sets them, on by default as Renovate
 * has them on GitHub, with the keys they set that Upkeep doesn't model. A
 * schedule or branch topic other than Renovate's would change when or where
 * a fix lands, so those are noted.
 */
const translateVulnerabilityAlerts = (config: Config) => {
  const own = mergeChildConfig(
    vulnerabilityDefaults,
    isConfig(config.vulnerabilityAlerts) ? config.vulnerabilityAlerts : {},
  );

  if (own.enabled === false) return { alerts: undefined, ignored: [] };

  const { set, ignored } = translateSettings(own);

  return {
    alerts: {
      settings: set,
      fixStrategy:
        own.vulnerabilityFixStrategy === "highest" ? "highest" : "lowest",
    } satisfies VulnerabilityAlerts,
    ignored: ignored.filter(
      (key) =>
        key !== "vulnerabilityFixStrategy" &&
        !(key === "schedule" && strings(own.schedule).length === 0) &&
        !(
          key === "branchTopic" &&
          own.branchTopic === vulnerabilityDefaults.branchTopic
        ),
    ),
  };
};

/** Translate a resolved Renovate config into Upkeep's Policy. */
export const toPolicy = (
  config: Config,
  file: string,
  unknown: ReadonlyArray<string>,
): Policy => {
  const notes = unknown.map((preset) => `unknown preset ${preset}, left out`);
  const ignoredKeys = new Map<string, number>();

  const ignore = (keys: ReadonlyArray<string>) => {
    for (const key of keys)
      ignoredKeys.set(key, (ignoredKeys.get(key) ?? 0) + 1);
  };

  // Renovate leaves submodules alone unless its config turns them on
  const rules: Array<Rule> = [
    { match: { managers: ["git-submodules"] }, set: { enabled: false } },
  ];

  // Renovate merges an update type's object in before the rules run again,
  // so the rules still win over it
  for (const type of UpdateType.literals) {
    const value = config[type];

    if (!isConfig(value)) continue;

    const { set, ignored } = translateSettings(value);

    ignore(ignored.map((key) => `${type}.${key}`));

    if (Object.keys(set).length > 0)
      rules.push({ match: { updateTypes: [type] }, set });
  }

  for (const manager of managers) {
    const value = config[manager];

    if (!isConfig(value)) continue;

    const { set, ignored } = translateSettings(value);

    ignore(ignored.map((key) => `${manager}.${key}`));

    if (Object.keys(set).length > 0)
      rules.push({ match: { managers: [manager] }, set });
  }

  for (const value of isList(config.packageRules) ? config.packageRules : []) {
    if (!isConfig(value)) continue;

    const { rule, ignored } = translateRule(value);

    ignore(ignored.map((key) => `packageRules.${key}`));

    if (Object.keys(rule.set).length === 0) continue;

    if (rule.unsupported !== undefined)
      notes.push(
        `a rule${rule.description === undefined ? "" : ` (${rule.description})`} uses ${rule.unsupported.join(", ")}, so it never matches`,
      );

    rules.push(rule);
  }

  const customManagers: Array<CustomManager> = [];

  for (const value of isList(config.customManagers)
    ? config.customManagers
    : []) {
    if (!isConfig(value)) continue;

    const result = translateManager(value);

    if (Result.isSuccess(result)) customManagers.push(result.success);
    else notes.push(result.failure);
  }

  const known = new Set<string>([
    ...settingKeys,
    ...UpdateType.literals,
    ...managers,
    "packageRules",
    "ignoreDeps",
    "ignorePaths",
    "enabledManagers",
    "customManagers",
    "customDatasources",
    "lockFileMaintenance",
    "vulnerabilityAlerts",
  ]);

  const vulnerabilityAlerts = translateVulnerabilityAlerts(config);

  ignore(
    vulnerabilityAlerts.ignored.map((key) => `vulnerabilityAlerts.${key}`),
  );

  for (const key of Object.keys(config))
    if (!known.has(key) && !presentation.has(key)) ignore([key]);

  if (ignoredKeys.size > 0)
    notes.push(
      `not modelled: ${[...ignoredKeys]
        .map(([key, count]) => (count > 1 ? `${key} (${count})` : key))
        .join(", ")}`,
    );

  const datasources = translateDatasources(config.customDatasources);

  notes.push(...datasources.notes);

  // `"enabled": false` at the top turns Renovate off for the repository, not
  // its dependencies: Upkeep keeps the rest of the config and takes over
  const own: Settings = translateSettings(config).set;
  const { enabled, ...settings } = own;
  const updaterRuns = enabled !== false;

  if (!updaterRuns)
    notes.push("Renovate is turned off, so Upkeep owns every group");

  return {
    updater: "renovate",
    updaterRuns,
    file,
    settings: enabled === true ? { ...settings, enabled } : settings,
    ignorePaths: strings(config.ignorePaths),
    enabledManagers: strings(config.enabledManagers),
    ignoreDeps: strings(config.ignoreDeps),
    rules,
    customManagers,
    customDatasources: datasources.datasources,
    maintenance: translateMaintenance(config, rules, settings.automerge),
    vulnerabilityAlerts: vulnerabilityAlerts.alerts,
    notes,
  };
};

/** Renovate's defaults that decide grouping, which presets merge over. */
const defaults = {
  pin: { groupName: "Pin Dependencies", groupSlug: "pin-dependencies" },
  pinDigest: { groupName: "Pin Dependencies", groupSlug: "pin-dependencies" },
} satisfies Config;

/** Read and resolve a repository's Renovate config into a Policy. */
export const read = Effect.fnUntraced(function* (
  repo: string,
  file: string,
  readFile: ReadFile,
) {
  const text = yield* readFile(repo, file);

  if (Option.isNone(text))
    return yield* new DepsError({ message: `${repo} has no ${file}` });

  const config = yield* parseConfig(text.value, file);
  const [owner = ""] = repo.split("/");
  const resolved = yield* resolvePresets(config, readFile, owner);

  return toPolicy(
    mergeChildConfig(defaults, resolved.config),
    file,
    resolved.unknown,
  );
});
