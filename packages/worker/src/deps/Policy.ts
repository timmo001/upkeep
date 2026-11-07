/**
 * Upkeep's own dependency policy: what the planner, managers and datasources
 * read. Each updater adapter (Renovate now, Dependabot later) translates its
 * config into this, and Upkeep's settings layer on top, so nothing past the
 * adapters knows which updater a repository uses.
 */
import { Schema } from "effect";

/** The kinds of update a rule can match and the planner reports. */
export const UpdateType = Schema.Literals([
  "major",
  "minor",
  "patch",
  "pin",
  "digest",
  "pinDigest",
]);

export type UpdateType = typeof UpdateType.Type;

export const Patterns = Schema.Array(Schema.String);

/**
 * What a rule applies to. Every given field must match. Lists take exact
 * names, globs, `/regex/` and `!` exclusions; a dependency missing the value
 * a field reads never matches it.
 */
export const Match = Schema.Struct({
  managers: Schema.optional(Patterns),
  datasources: Schema.optional(Patterns),
  depTypes: Schema.optional(Patterns),
  packageNames: Schema.optional(Patterns),
  depNames: Schema.optional(Patterns),
  fileNames: Schema.optional(Patterns),
  sourceUrls: Schema.optional(Patterns),
  updateTypes: Schema.optional(Patterns),
  categories: Schema.optional(Patterns),
  repositories: Schema.optional(Patterns),
  baseBranches: Schema.optional(Patterns),
  /** One pattern for the value as written, such as `^1.2.3`. */
  currentValue: Schema.optional(Schema.String),
  /** A semver range or pattern for the version in use. */
  currentVersion: Schema.optional(Schema.String),
});

export type Match = typeof Match.Type;

/**
 * What a rule sets. Null clears a setting an earlier rule gave. Keys are
 * left out rather than undefined, since a later rule's keys replace earlier
 * ones.
 */
export const Settings = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  /** Whether the updater merges the group itself, which makes it the owner. */
  automerge: Schema.optionalKey(Schema.Boolean),
  groupName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  groupSlug: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** A semver range or `/regex/` the new version must match. */
  allowedVersions: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** How old a release must be, such as `1 day`. */
  minimumReleaseAge: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ignoreUnstable: Schema.optionalKey(Schema.Boolean),
  respectLatest: Schema.optionalKey(Schema.Boolean),
  pinDigests: Schema.optionalKey(Schema.Boolean),
  separateMajorMinor: Schema.optionalKey(Schema.Boolean),
  separateMinorPatch: Schema.optionalKey(Schema.Boolean),
  separateMultipleMajor: Schema.optionalKey(Schema.Boolean),
  rangeStrategy: Schema.optionalKey(Schema.String),
  versioning: Schema.optionalKey(Schema.NullOr(Schema.String)),
  extractVersion: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export type Settings = typeof Settings.Type;

export const Rule = Schema.Struct({
  description: Schema.optional(Schema.String),
  match: Match,
  set: Settings,
  /**
   * Matchers the adapter couldn't translate. A rule with any never matches,
   * since what it was meant to cover is unknown.
   */
  unsupported: Schema.optional(Patterns),
});

export type Rule = typeof Rule.Type;

/** Templates a custom manager fills in from its captures. */
export const Templates = Schema.Struct({
  depName: Schema.optional(Schema.String),
  packageName: Schema.optional(Schema.String),
  datasource: Schema.optional(Schema.String),
  depType: Schema.optional(Schema.String),
  currentValue: Schema.optional(Schema.String),
  versioning: Schema.optional(Schema.String),
  extractVersion: Schema.optional(Schema.String),
});

export type Templates = typeof Templates.Type;

/** Dependencies found by patterns over files no built-in manager reads. */
export const CustomManager = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("regex"),
    description: Schema.optional(Schema.String),
    files: Patterns,
    patterns: Patterns,
    strategy: Schema.Literals(["any", "recursive", "combination"]),
    templates: Templates,
  }),
  Schema.Struct({
    type: Schema.Literal("jsonata"),
    description: Schema.optional(Schema.String),
    files: Patterns,
    patterns: Patterns,
    format: Schema.String,
    templates: Templates,
  }),
]);

export type CustomManager = typeof CustomManager.Type;

/**
 * A datasource a config defines itself: a URL to fetch, in a format, and
 * JSONata transforms that turn what it returns into releases.
 */
export interface CustomDatasource {
  /** The URL, with `{{packageName}}` and `{{currentValue}}` filled in. */
  readonly registryUrlTemplate: string | undefined;
  /** `json`, `plain`, `yaml` or `toml`. */
  readonly format: string;
  readonly transformTemplates: ReadonlyArray<string>;
}

/** Renovate's lock file maintenance: every lockfile written afresh, on a schedule. */
export interface Maintenance {
  /** Whether the updater merges it itself, which makes it the owner. */
  readonly automerge: boolean;
  /** How often it's due, in days. */
  readonly everyDays: number;
}

export interface Policy {
  /** The updater whose config this came from, which owns automerged groups. */
  readonly updater: string;
  /**
   * Whether the updater itself still runs. When its config turns it off,
   * Upkeep keeps reading the config and owns every group.
   */
  readonly updaterRuns: boolean;
  /** The config file it was read from. */
  readonly file: string;
  /** Settings every dependency starts from. */
  readonly settings: Settings;
  readonly ignorePaths: ReadonlyArray<string>;
  /** Managers to run; empty means all of them. */
  readonly enabledManagers: ReadonlyArray<string>;
  readonly ignoreDeps: ReadonlyArray<string>;
  /** Applied in order, later rules winning. */
  readonly rules: ReadonlyArray<Rule>;
  readonly customManagers: ReadonlyArray<CustomManager>;
  /** Datasources the config defines, by name without the `custom.` prefix. */
  readonly customDatasources: Readonly<Record<string, CustomDatasource>>;
  /** Lock file maintenance, when the config turns it on. */
  readonly maintenance?: Maintenance | undefined;
  /** What the adapter read but couldn't model, for the run's log. */
  readonly notes: ReadonlyArray<string>;
}

/** One dependency as a manager found it. */
export interface Dependency {
  readonly manager: string;
  readonly file: string;
  /** Lockfiles that pin it, which `fileNames` matches too. */
  readonly lockFiles?: ReadonlyArray<string> | undefined;
  /** The name as written, such as a mise tool or an npm alias. */
  readonly depName: string;
  /** What the datasource looks up. */
  readonly packageName: string;
  readonly datasource: string;
  readonly depType: string;
  /** The value as written, such as `^1.2.3` or `v4`. */
  readonly currentValue: string;
  /** The version in use, from a lockfile or a version comment. */
  readonly lockedVersion?: string | undefined;
  readonly currentDigest?: string | undefined;
  /** Undefined until looked up; null when the datasource has none. */
  readonly sourceUrl?: string | null | undefined;
  readonly versioning?: string | undefined;
  readonly extractVersion?: string | undefined;
  /** The text a custom regex matched, which an update rewrites in place. */
  readonly replaceString?: string | undefined;
}

export interface Release {
  readonly version: string;
  readonly digest?: string | undefined;
  /** ISO time it was published. */
  readonly date?: string | undefined;
  /** The datasource marks it a prerelease, whatever its version says. */
  readonly prerelease?: boolean | undefined;
}

export interface Releases {
  readonly releases: ReadonlyArray<Release>;
  /** npm's `latest` dist-tag. */
  readonly latest?: string | undefined;
  readonly sourceUrl?: string | null | undefined;
}

/** Where a repository is being read from. */
export interface Repository {
  /** `owner/name`. */
  readonly repo: string;
  readonly branch: string;
}

/** Reading or planning a repository's dependencies failed. */
export class DepsError extends Schema.TaggedError<DepsError>()("DepsError", {
  message: Schema.String,
}) {}
