/**
 * Upkeep's rule evaluation: which rules apply to a dependency, and the
 * settings it ends up with. Patterns follow Renovate's matchers, so a config
 * read from Renovate means the same here: exact names, globs and `/regex/`,
 * any positive pattern matching and every `!` exclusion holding.
 */
import { minimatch } from "minimatch";
import semver from "semver";
import type { Dependency, Match, Policy, Settings, UpdateType } from "./Policy";

const regexPattern = /^!?\/(?<source>.*)\/(?<flags>i?)$/;

/** One pattern against one value, a `!` pattern holding when it doesn't match. */
export const matchesPattern = (value: string, pattern: string) => {
  if (pattern === "*") return true;
  const regex = regexPattern.exec(pattern)?.groups;

  if (regex !== undefined) {
    const result = new RegExp(regex.source ?? "", regex.flags).test(value);

    return pattern.startsWith("!") ? !result : result;
  }

  return minimatch(value, pattern, { dot: true, nocase: true });
};

/**
 * A value against a list: false for an empty list, any positive pattern must
 * match when there are some, and every `!` pattern must hold.
 */
export const matchesPatterns = (
  value: string,
  patterns: ReadonlyArray<string>,
) => {
  if (patterns.length === 0) return false;

  const positive = patterns.filter((pattern) => !pattern.startsWith("!"));
  const negative = patterns.filter((pattern) => pattern.startsWith("!"));

  return (
    (positive.length === 0 ||
      positive.some((pattern) => matchesPattern(value, pattern))) &&
    negative.every((pattern) => matchesPattern(value, pattern))
  );
};

/** Renovate's categories for the managers Upkeep reads. */
const categories = new Map([
  ["npm", ["js"]],
  ["bun", ["js"]],
  ["github-actions", ["ci"]],
  ["git-submodules", ["git"]],
  ["dockerfile", ["docker"]],
  ["docker-compose", ["docker"]],
]);

export const managerCategories = (manager: string) =>
  categories.get(manager) ?? [];

/** What the matchers read besides the dependency itself. */
export interface Context {
  readonly repository?: string | undefined;
  readonly branch?: string | undefined;
  readonly updateType?: UpdateType | undefined;
}

/** Whether a version range or regex covers the version in use. */
const matchesCurrentVersion = (dependency: Dependency, pattern: string) => {
  if (regexPattern.test(pattern)) {
    const version = dependency.lockedVersion ?? dependency.currentValue;

    return matchesPattern(version, pattern);
  }

  // An exact version matches when the range in use allows it
  if (semver.valid(pattern) !== null)
    return (
      semver.validRange(dependency.currentValue) !== null &&
      semver.satisfies(pattern, dependency.currentValue)
    );

  const version =
    semver.valid(dependency.currentValue) ?? dependency.lockedVersion;

  return (
    version !== undefined &&
    semver.valid(version) !== null &&
    semver.satisfies(version, pattern, { includePrerelease: true })
  );
};

/** Whether every matcher a rule gives holds; one with none always matches. */
export const matchesRule = (
  match: Match,
  dependency: Dependency,
  context: Context = {},
) => {
  const list = (
    patterns: ReadonlyArray<string> | undefined,
    values: ReadonlyArray<string | null | undefined>,
  ) =>
    patterns === undefined ||
    values.some(
      (value) =>
        value !== undefined &&
        value !== null &&
        matchesPatterns(value, patterns),
    );

  return (
    list(match.repositories, [context.repository]) &&
    list(match.baseBranches, [context.branch]) &&
    list(match.categories, managerCategories(dependency.manager)) &&
    list(match.managers, [dependency.manager]) &&
    list(match.fileNames, [dependency.file, ...(dependency.lockFiles ?? [])]) &&
    list(match.datasources, [dependency.datasource]) &&
    list(match.packageNames, [dependency.packageName]) &&
    list(match.depNames, [dependency.depName]) &&
    list(match.depTypes, [dependency.depType]) &&
    (match.currentValue === undefined ||
      matchesPattern(dependency.currentValue, match.currentValue)) &&
    (match.currentVersion === undefined ||
      matchesCurrentVersion(dependency, match.currentVersion)) &&
    list(match.updateTypes, [context.updateType]) &&
    list(match.sourceUrls, [dependency.sourceUrl])
  );
};

/** Renovate's defaults for the settings Upkeep models. */
export const defaults: Settings = {
  enabled: true,
  automerge: false,
  ignoreUnstable: true,
  respectLatest: true,
  pinDigests: false,
  separateMajorMinor: true,
  separateMinorPatch: false,
  separateMultipleMajor: false,
  rangeStrategy: "auto",
};

/**
 * A dependency's settings: the defaults, the policy's, then each matching
 * rule in order. A rule naming a group without a slug resets the slug, as
 * Renovate does, so the later group wins.
 */
export const settingsFor = (
  policy: Policy,
  dependency: Dependency,
  context: Context = {},
): Settings => {
  let settings: Settings = { ...defaults, ...policy.settings };

  if (dependency.versioning !== undefined)
    settings = { ...settings, versioning: dependency.versioning };

  if (dependency.extractVersion !== undefined)
    settings = { ...settings, extractVersion: dependency.extractVersion };

  for (const rule of policy.rules) {
    if (rule.unsupported !== undefined && rule.unsupported.length > 0) continue;

    if (!matchesRule(rule.match, dependency, context)) continue;

    if (rule.set.groupName !== undefined && rule.set.groupSlug === undefined)
      settings = { ...settings, groupSlug: null };

    settings = { ...settings, ...rule.set };
  }

  if (matchesPatterns(dependency.depName, policy.ignoreDeps))
    settings = { ...settings, enabled: false };

  return settings;
};
