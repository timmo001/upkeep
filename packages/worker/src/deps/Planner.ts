/**
 * The planner: for each dependency, the releases its policy allows, then the
 * updates Renovate would make of them, grouped into the branches it would
 * open. Each group has an owner: the updater when it runs and every update
 * in it automerges, otherwise Upkeep.
 */
import semver from "semver";
import { newValue } from "./Applier";
import type {
  Dependency,
  Policy,
  Release,
  Releases,
  Settings,
  UpdateType,
} from "./Policy";
import { type Context, matchesPattern, settingsFor } from "./Rules";

/** A version as comparable parts, with any prerelease after them. */
interface Version {
  readonly parts: ReadonlyArray<number>;
  readonly prerelease: string | undefined;
}

/**
 * Parse a version by its versioning: semver-like by default, or Renovate's
 * `regex:` versioning with major, minor, patch, build and prerelease groups.
 */
export const parseVersion = (
  version: string,
  versioning: string | null | undefined,
): Version | undefined => {
  if (versioning?.startsWith("regex:") === true) {
    const groups = new RegExp(versioning.slice("regex:".length)).exec(
      version,
    )?.groups;

    if (groups === undefined) return undefined;

    return {
      parts: ["major", "minor", "patch", "build"].map((name) =>
        Number(groups[name] ?? 0),
      ),
      prerelease: groups.prerelease === "" ? undefined : groups.prerelease,
    };
  }

  const parsed =
    semver.parse(version, { loose: true }) ??
    (/^v?\d+(?:\.\d+)?$/.test(version) ? semver.coerce(version) : null);

  if (parsed === null) return undefined;

  return {
    parts: [parsed.major, parsed.minor, parsed.patch],
    prerelease:
      parsed.prerelease.length === 0 ? undefined : parsed.prerelease.join("."),
  };
};

export const compareVersions = (a: Version, b: Version) => {
  for (
    let index = 0;
    index < Math.max(a.parts.length, b.parts.length);
    index++
  ) {
    const difference = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);

    if (difference !== 0) return difference;
  }

  if (a.prerelease === undefined || b.prerelease === undefined)
    return (
      Number(a.prerelease === undefined) - Number(b.prerelease === undefined)
    );

  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
};

/** How long a release must have been out, from Renovate's `1 day` form. */
export const ageMillis = (age: string | null | undefined) => {
  if (age === null || age === undefined || age === "") return 0;

  const match =
    /^(?<count>\d+(?:\.\d+)?)\s*(?<unit>second|minute|hour|day|week|month)s?$/.exec(
      age.trim(),
    )?.groups;

  if (match === undefined) return undefined;

  const units = new Map([
    ["second", 1000],
    ["minute", 60_000],
    ["hour", 3_600_000],
    ["day", 86_400_000],
    ["week", 604_800_000],
    ["month", 2_592_000_000],
  ]);

  return Number(match.count) * (units.get(match.unit ?? "") ?? 0);
};

/** One update Renovate would make. */
export interface Update {
  readonly dependency: Dependency;
  readonly updateType: UpdateType;
  readonly from: string;
  readonly to: string;
  readonly settings: Settings;
  /** The branch it would go on, without Renovate's `renovate/` prefix. */
  readonly branch: string;
  /** In range, so only the lockfile moves. */
  readonly lockfile: boolean;
  /** The full commit it moves to, when the dependency is pinned to one. */
  readonly digest?: string | undefined;
  /** The package a replacement moves to. */
  readonly newName?: string | undefined;
}

/** Why a dependency has no update, when it's worth saying. */
export interface Skipped {
  readonly dependency: Dependency;
  readonly reason: string;
}

/** Renovate's slugify of a group name. */
export const slugify = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^\w\s$*+~.()'"!:@-]/g, "")
    .replace(/\s+/g, "-");

/** Renovate's depNameSanitized, which ungrouped branches are named after. */
export const sanitize = (depName: string) =>
  depName
    .replace("@types/", "types-")
    .replace("@", "")
    .replace(/\//g, "-")
    .replace(/\s+/g, "-")
    .replace(/:/g, "-")
    .replace(/-+/, "-")
    .toLowerCase();

/** The branch an update goes on, as Renovate names it. */
export const branchFor = (
  dependency: Dependency,
  settings: Settings,
  updateType: UpdateType,
  next: Version | undefined,
  lockfile: boolean,
) => {
  if (
    settings.groupName !== undefined &&
    settings.groupName !== null &&
    settings.groupName !== ""
  ) {
    const slug = slugify(settings.groupSlug ?? settings.groupName);

    if (updateType === "major" && settings.separateMajorMinor !== false)
      return settings.separateMultipleMajor === true
        ? `major-${next?.parts[0] ?? 0}-${slug}`
        : `major-${slug}`;

    if (updateType === "patch" && settings.separateMinorPatch === true)
      return `patch-${slug}`;

    return slug;
  }

  const name = sanitize(dependency.depName);

  if (updateType === "digest") return `${name}-digest`;

  if (updateType === "replacement") return `${name}-replacement`;

  const minor =
    settings.separateMinorPatch === true && updateType === "patch"
      ? `.${next?.parts[1] ?? 0}`
      : "";

  return `${name}-${next?.parts[0] ?? 0}${minor}.x${lockfile ? "-lockfile" : ""}`;
};

const isRange = (value: string) =>
  semver.valid(value) === null && semver.validRange(value) !== null;

/** How many numeric parts a version gives: 1 for `v7`, 3 for `7.0.1`. */
const partsOf = (version: string) =>
  /^v?(?<numbers>\d+(?:\.\d+)*)/.exec(version)?.groups?.numbers?.split(".")
    .length;

/** Renovate's bucket for an update, where only the newest release is kept. */
const bucket = (settings: Settings, updateType: UpdateType, next: Version) => {
  if (updateType === "major" && settings.separateMajorMinor !== false)
    return settings.separateMultipleMajor === true
      ? `major-${next.parts[0]}`
      : "major";

  if (settings.separateMajorMinor === false) return "latest";

  if (settings.separateMinorPatch === true) return updateType;

  return "non-major";
};

/** A dependency's updates, or why it gets none. */
export interface Plan {
  readonly updates: ReadonlyArray<Update>;
  readonly skipped?: string;
}

/**
 * The replacement a dependency's settings name, as Renovate makes it: the new
 * package, or the same one, at the version given or the current value, as
 * long as one of them changes.
 */
const replacementFor = (
  policy: Policy,
  dependency: Dependency,
  base: Settings,
  context: Context,
): Update | undefined => {
  const name = base.replacementName ?? "";
  const version = base.replacementVersion ?? "";

  if (name === "" && version === "") return undefined;

  const newName = name === "" ? dependency.packageName : name;
  const to = version === "" ? dependency.currentValue : version;

  if (
    newName === dependency.packageName &&
    (newValue(dependency.currentValue, to) ?? to) === dependency.currentValue
  )
    return undefined;

  const settings = settingsFor(policy, dependency, {
    ...context,
    updateType: "replacement",
  });

  if (settings.enabled === false) return undefined;

  return {
    dependency,
    updateType: "replacement",
    from: dependency.currentValue,
    to,
    settings,
    branch: branchFor(dependency, settings, "replacement", undefined, false),
    lockfile: false,
    newName,
  };
};

/** The version and digest updates a dependency gets, or why it gets none. */
const versionUpdates = (
  policy: Policy,
  withSource: Dependency,
  metadata: Releases,
  now: number,
  base: Settings,
  context: Context,
): Plan => {
  const versioning = base.versioning;

  const extract = (release: Release) => {
    if (base.extractVersion === undefined || base.extractVersion === null)
      return release.version;

    return new RegExp(base.extractVersion).exec(release.version)?.groups
      ?.version;
  };

  // git-refs follow a branch, so the only update is a new commit
  if (withSource.datasource === "git-refs") {
    const head = metadata.releases[0];

    if (
      head?.digest === undefined ||
      withSource.currentDigest === undefined ||
      head.digest.startsWith(withSource.currentDigest)
    )
      return { updates: [] };

    const settings = settingsFor(policy, withSource, {
      ...context,
      updateType: "digest",
    });

    if (settings.enabled === false) return { updates: [], skipped: "disabled" };

    return {
      updates: [
        {
          dependency: withSource,
          updateType: "digest",
          from: withSource.currentDigest.slice(0, 7),
          to: head.digest.slice(0, 7),
          settings,
          branch: branchFor(withSource, settings, "digest", undefined, false),
          lockfile: false,
          digest: head.digest,
        },
      ],
    };
  }

  // A tag like `v7` is a version of its own, not a range: Renovate only moves
  // it to another tag of the same precision, such as `v8`, or to `v7`'s digest
  const precision =
    withSource.datasource === "github-tags" &&
    /^v?\d+(?:\.\d+)?$/.test(withSource.currentValue)
      ? partsOf(withSource.currentValue)
      : undefined;

  // With no locked version, Renovate takes the highest release in the range
  // that isn't past latest, so nothing inside the range is an update
  const inRange = (range: string) => {
    const versions = metadata.releases.flatMap((release) => {
      const text = extract(release);

      return text !== undefined && semver.satisfies(text, range) ? [text] : [];
    });

    const latest = metadata.latest;

    const capped =
      latest !== undefined && semver.satisfies(latest, range)
        ? versions.filter((version) => semver.lte(version, latest))
        : versions;

    return (
      semver.maxSatisfying(capped, range) ?? semver.minVersion(range)?.version
    );
  };

  const currentText =
    withSource.lockedVersion ??
    (precision === undefined && isRange(withSource.currentValue)
      ? inRange(withSource.currentValue)
      : withSource.currentValue);

  const current =
    currentText === undefined
      ? undefined
      : parseVersion(currentText, versioning);

  if (current === undefined)
    return {
      updates: [],
      skipped: `can't read version ${withSource.currentValue}`,
    };

  const latest =
    metadata.latest === undefined
      ? undefined
      : parseVersion(metadata.latest, versioning);

  const best = new Map<string, Update & { readonly version: Version }>();
  let pending = 0;

  for (const release of metadata.releases) {
    const text = extract(release);

    if (text === undefined) continue;

    if (precision !== undefined && partsOf(text) !== precision) continue;

    const next = parseVersion(text, versioning);

    if (next === undefined) continue;

    const order = compareVersions(next, current);

    // The version in use, which can still need its digest pinned or moved
    if (order === 0) {
      if (release.digest === undefined) continue;

      const updateType: UpdateType | undefined =
        withSource.currentDigest === undefined
          ? base.pinDigests === true
            ? "pinDigest"
            : undefined
          : release.digest.startsWith(withSource.currentDigest)
            ? undefined
            : "digest";

      if (updateType === undefined) continue;

      const settings = settingsFor(policy, withSource, {
        ...context,
        updateType,
      });

      if (settings.enabled === false) continue;

      best.set(updateType, {
        dependency: withSource,
        updateType,
        from: withSource.currentDigest?.slice(0, 7) ?? withSource.currentValue,
        to: release.digest.slice(0, 7),
        settings,
        branch: branchFor(withSource, settings, updateType, next, false),
        lockfile: false,
        digest: release.digest,
        version: next,
      });

      continue;
    }

    if (order < 0) continue;

    const updateType: UpdateType =
      next.parts[0] !== current.parts[0]
        ? "major"
        : next.parts[1] !== current.parts[1]
          ? "minor"
          : "patch";

    const settings = settingsFor(policy, withSource, {
      ...context,
      updateType,
    });

    if (settings.enabled === false) continue;

    if (
      settings.ignoreUnstable !== false &&
      (release.prerelease === true || next.prerelease !== undefined) &&
      current.prerelease === undefined
    )
      continue;

    const allowed = settings.allowedVersions;

    if (allowed !== undefined && allowed !== null) {
      if (/^!?\//.test(allowed)) {
        if (!matchesPattern(text, allowed)) continue;
      } else {
        const coerced = semver.coerce(text, { includePrerelease: true });

        if (
          coerced === null ||
          !semver.satisfies(coerced, allowed, { includePrerelease: true })
        )
          continue;
      }
    }

    if (
      settings.respectLatest !== false &&
      latest !== undefined &&
      compareVersions(next, latest) > 0 &&
      compareVersions(current, latest) <= 0
    )
      continue;

    const age = ageMillis(settings.minimumReleaseAge);

    if (age === undefined) continue;

    if (age > 0) {
      const date =
        release.date === undefined ? Number.NaN : Date.parse(release.date);

      if (!Number.isFinite(date) || now - date < age) {
        pending += 1;

        continue;
      }
    }

    const lockfile =
      withSource.lockedVersion !== undefined &&
      isRange(withSource.currentValue) &&
      semver.satisfies(text, withSource.currentValue);

    const key = bucket(settings, updateType, next);
    const previous = best.get(key);

    if (previous !== undefined && compareVersions(previous.version, next) >= 0)
      continue;

    best.set(key, {
      dependency: withSource,
      updateType,
      from: currentText ?? withSource.currentValue,
      to: text,
      settings,
      branch: branchFor(withSource, settings, updateType, next, lockfile),
      lockfile,
      digest:
        withSource.currentDigest === undefined ? undefined : release.digest,
      version: next,
    });
  }

  const updates = [...best.values()];

  return updates.length === 0 && pending > 0
    ? {
        updates,
        skipped: `${pending} newer ${pending === 1 ? "release isn't" : "releases aren't"} old enough yet`,
      }
    : { updates };
};

/** The updates a dependency gets, or why it gets none. */
export const updatesFor = (
  policy: Policy,
  dependency: Dependency,
  metadata: Releases,
  now: number,
  repository?: string,
): Plan => {
  const withSource: Dependency =
    dependency.sourceUrl === undefined && metadata.sourceUrl !== undefined
      ? { ...dependency, sourceUrl: metadata.sourceUrl }
      : dependency;

  const context = { repository };
  const base = settingsFor(policy, withSource, context);

  if (base.enabled === false) return { updates: [], skipped: "disabled" };

  const plan = versionUpdates(policy, withSource, metadata, now, base, context);
  const replacement = replacementFor(policy, withSource, base, context);

  // Renovate adds the replacement beside the version updates, on its own branch
  return replacement === undefined
    ? plan
    : { updates: [...plan.updates, replacement] };
};

/** Updates sharing a branch, which Renovate opens as one pull request. */
export interface Group {
  readonly branch: string;
  readonly name: string;
  readonly updates: ReadonlyArray<Update>;
  /** The updater when it runs and every update automerges, otherwise Upkeep. */
  readonly owner: string;
}

/** Group updates by branch, in branch order. */
export const group = (policy: Policy, updates: ReadonlyArray<Update>) => {
  const branches = new Map<string, Array<Update>>();

  for (const update of updates)
    branches.set(update.branch, [
      ...(branches.get(update.branch) ?? []),
      update,
    ]);

  return [...branches.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([branch, members]): Group => ({
      branch,
      name:
        members[0]?.settings.groupName ??
        members[0]?.dependency.depName ??
        branch,
      updates: members,
      owner:
        policy.updaterRuns &&
        members.every((update) => update.settings.automerge === true)
          ? policy.updater
          : "upkeep",
    }));
};
