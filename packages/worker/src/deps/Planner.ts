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
  Vulnerability,
} from "./Policy";
import { type Context, matchesPattern, settingsFor } from "./Rules";

/** A version as comparable parts, with any prerelease after them. */
export interface Version {
  readonly parts: ReadonlyArray<number>;
  readonly prerelease: string | undefined;
}

/** A Docker tag as a version, with the suffix after its first `-`. */
export interface DockerVersion extends Version {
  readonly suffix: string;
}

/**
 * Parse a tag as Renovate's docker versioning does: numbers, then any
 * letters as a prerelease, such as `3.13.0rc1`, then a suffix after the first
 * `-`, such as `alpine`. Commit hashes and words such as `latest` aren't
 * versions.
 */
export const dockerVersion = (tag: string): DockerVersion | undefined => {
  if (/^[a-f\d]{7,40}$/.test(tag) && !/^\d+$/.test(tag)) return undefined;

  const [prefix = "", ...suffix] = tag.replace(/^v/, "").split("-");

  const groups = /^(?<version>\d+(?:\.\d+)*)(?<prerelease>\w*)$/.exec(
    prefix,
  )?.groups;

  if (groups?.version === undefined) return undefined;

  return {
    parts: groups.version.split(".").map(Number),
    prerelease: groups.prerelease === "" ? undefined : groups.prerelease,
    suffix: suffix.join("-"),
  };
};

/**
 * Whether a tag can replace another under docker versioning: the same suffix
 * and the same number of version parts, so `22-alpine` only moves to tags
 * such as `24-alpine`.
 */
export const dockerCompatible = (tag: string, current: string) => {
  const a = dockerVersion(tag);
  const b = dockerVersion(current);

  return (
    a !== undefined &&
    b !== undefined &&
    a.suffix === b.suffix &&
    a.parts.length === b.parts.length
  );
};

/**
 * A value split by a `versionCompatibility` regex into the version compared
 * and the compatibility every release must share, such as `22` and `-alpine`.
 */
export const splitCompatibility = (pattern: string, value: string) => {
  const groups = new RegExp(pattern).exec(value)?.groups;

  return groups?.version === undefined
    ? undefined
    : { version: groups.version, compatibility: groups.compatibility };
};

/**
 * Parse a version by its versioning: semver-like by default, Renovate's
 * `docker` versioning, or its `regex:` versioning with major, minor, patch,
 * build and prerelease groups.
 */
export const parseVersion = (
  version: string,
  versioning: string | null | undefined,
): Version | undefined => {
  if (versioning === "docker") return dockerVersion(version);

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
  /** Fixes an open vulnerability alert. */
  readonly vulnerable?: boolean | undefined;
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

/**
 * The range strategy Renovate's npm manager resolves a dependency's to:
 * `auto` widens a peer dependency or a range of several parts, such as
 * `^1 || ^2`, and otherwise only updates the lockfile within the range;
 * `in-range-only` updates the lockfile too.
 */
const resolveRangeStrategy = (
  dependency: Dependency,
  rangeStrategy: string | null | undefined,
) => {
  if (rangeStrategy === "in-range-only") return "update-lockfile";

  if (
    rangeStrategy !== undefined &&
    rangeStrategy !== null &&
    rangeStrategy !== "auto"
  )
    return rangeStrategy;

  const complex =
    dependency.currentValue.trim().split(/\s*\|\|\s*|\s+/).length > 1;

  return dependency.depType === "peerDependencies" || complex
    ? "widen"
    : "update-lockfile";
};

/** How many numeric parts a version gives: 1 for `v7`, 3 for `7.0.1`. */
const partsOf = (version: string) =>
  /^v?(?<numbers>\d+(?:\.\d+)*)/.exec(version)?.groups?.numbers?.split(".")
    .length;

/** A digest as it's shown: a commit's first 7, or an image's after `sha256:`. */
const shortDigest = (digest: string) =>
  digest.replace(/^sha256:/, "").slice(0, 7);

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

/** The datasources each GitHub advisory ecosystem's packages come from. */
const ecosystems = new Map<string, ReadonlyArray<string>>([
  ["actions", ["github-tags"]],
  ["composer", ["packagist"]],
  ["go", ["go"]],
  ["maven", ["maven", "clojure"]],
  ["npm", ["npm"]],
  ["nuget", ["nuget"]],
  ["pip", ["pypi"]],
  ["rubygems", ["rubygems"]],
  ["rust", ["crate"]],
]);

/** An open Dependabot alert, as far as a fix needs it. */
export interface Alert {
  readonly ecosystem: string;
  readonly packageName: string;
  readonly firstPatchedVersion: string | undefined;
}

/**
 * Combine a repository's open alerts as Renovate does: one fix per package,
 * the highest of their first patched versions, leaving out alerts with no
 * patch yet and ecosystems with no datasource.
 */
export const vulnerabilities = (
  alerts: ReadonlyArray<Alert>,
): ReadonlyArray<Vulnerability> => {
  const fixes = new Map<
    string,
    Vulnerability & { readonly version: Version }
  >();

  for (const alert of alerts) {
    const datasources = ecosystems.get(alert.ecosystem);
    const fixVersion = alert.firstPatchedVersion;

    if (datasources === undefined || fixVersion === undefined) continue;

    const version = parseVersion(fixVersion, undefined);

    if (version === undefined) continue;

    const key = `${alert.ecosystem}:${alert.packageName}`;
    const previous = fixes.get(key);

    if (
      previous !== undefined &&
      compareVersions(previous.version, version) >= 0
    )
      continue;

    fixes.set(key, {
      datasources,
      packageName: alert.packageName,
      fixVersion,
      version,
    });
  }

  return [...fixes.values()].map(
    ({ datasources, packageName, fixVersion }) => ({
      datasources,
      packageName,
      fixVersion,
    }),
  );
};

/** The fix for an open alert a dependency's updates are cut down to. */
interface Fix {
  readonly version: Version;
  readonly strategy: "lowest" | "highest";
  /** The alerts' settings, forced over the dependency's own. */
  readonly settings: Settings;
}

/** The fix for the open alert on a dependency's package, when alerts are on. */
const fixFor = (
  policy: Policy,
  dependency: Dependency,
  versioning: string | null | undefined,
): Fix | undefined => {
  const alerts = policy.vulnerabilityAlerts;

  if (alerts === undefined) return undefined;

  const alert = policy.vulnerabilities?.find(
    (candidate) =>
      candidate.datasources.includes(dependency.datasource) &&
      candidate.packageName.toLowerCase() ===
        dependency.packageName.toLowerCase(),
  );

  const version =
    alert === undefined
      ? undefined
      : parseVersion(alert.fixVersion, versioning);

  return version === undefined
    ? undefined
    : { version, strategy: alerts.fixStrategy, settings: alerts.settings };
};

/** Renovate's branch for a vulnerability fix, unless its settings group it. */
const vulnerabilityBranch = (
  dependency: Dependency,
  settings: Settings,
  updateType: UpdateType,
  next: Version,
) =>
  settings.groupName !== undefined &&
  settings.groupName !== null &&
  settings.groupName !== ""
    ? branchFor(dependency, settings, updateType, next, false)
    : `${dependency.datasource}-${sanitize(dependency.depName)}-vulnerability`;

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
  fix: Fix | undefined,
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

  const docker = withSource.datasource === "docker";

  // An image named without a tag runs `latest`
  const tag =
    docker && withSource.currentValue === ""
      ? "latest"
      : withSource.currentValue;

  // `versionCompatibility` splits a value into the version compared and the
  // part every release must share, such as `-alpine`; a value it doesn't
  // match is read whole, as Renovate does
  const compatibilityPattern = base.versionCompatibility ?? undefined;

  const compatible =
    compatibilityPattern === undefined
      ? undefined
      : splitCompatibility(compatibilityPattern, tag);

  const currentValue = compatible?.version ?? tag;

  const read = (release: Release) => {
    const text = extract(release);

    if (
      text === undefined ||
      compatible === undefined ||
      compatibilityPattern === undefined
    )
      return text;

    const split = splitCompatibility(compatibilityPattern, text);

    return split?.compatibility === compatible.compatibility
      ? split?.version
      : undefined;
  };

  // A tag like `v7` is a version of its own, not a range: Renovate only moves
  // it to another tag of the same precision, such as `v8`, or to `v7`'s
  // digest. An image's tag always is
  const precision =
    docker ||
    (withSource.datasource === "github-tags" &&
      /^v?\d+(?:\.\d+)?$/.test(currentValue))
      ? partsOf(currentValue)
      : undefined;

  // With no locked version, or a range strategy that moves the range rather
  // than the lockfile, Renovate takes the highest release in the range that
  // isn't past latest, so nothing inside the range is an update. A fix bumps
  // the range instead, so it reads from the lowest
  const inRange = (range: string, lowest: boolean) => {
    const versions = metadata.releases.flatMap((release) => {
      const text = read(release);

      return text !== undefined && semver.satisfies(text, range) ? [text] : [];
    });

    const latest = metadata.latest;

    const capped =
      latest !== undefined && semver.satisfies(latest, range)
        ? versions.filter((version) => semver.lte(version, latest))
        : versions;

    return (
      (lowest
        ? semver.minSatisfying(capped, range)
        : semver.maxSatisfying(capped, range)) ??
      semver.minVersion(range)?.version
    );
  };

  const currentFor = (lowest: boolean, locked: string | undefined) => {
    const text =
      locked ??
      (precision === undefined && !docker && isRange(currentValue)
        ? inRange(currentValue, lowest)
        : currentValue);

    return {
      text,
      version: text === undefined ? undefined : parseVersion(text, versioning),
    };
  };

  // Renovate's alert rule matches the locked version where there is one
  const vulnerable =
    fix === undefined ? undefined : currentFor(true, withSource.lockedVersion);

  // Renovate's alert rule only matches a dependency still below the fix
  const fixing =
    vulnerable?.version !== undefined &&
    fix !== undefined &&
    compareVersions(vulnerable.version, fix.version) < 0
      ? fix
      : undefined;

  const rangeStrategy =
    fixing?.settings.rangeStrategy ?? base.rangeStrategy ?? undefined;

  // Updating the lockfile moves on from the locked version, so a newer
  // release within the range is an update of its own
  const locked =
    resolveRangeStrategy(withSource, rangeStrategy) === "update-lockfile"
      ? withSource.lockedVersion
      : undefined;

  // `in-range-only` keeps to releases the range already allows
  const allowedRange =
    rangeStrategy === "in-range-only" &&
    semver.validRange(withSource.currentValue) !== null
      ? withSource.currentValue
      : undefined;

  const { text: currentText, version: current } =
    fixing === undefined || vulnerable === undefined
      ? currentFor(false, locked)
      : vulnerable;

  // The version in use, which can still need its digest pinned or moved
  const digestUpdate = (
    release: Release,
    next: Version | undefined,
  ): Update | undefined => {
    if (release.digest === undefined || fixing !== undefined) return undefined;

    const updateType: UpdateType | undefined =
      withSource.currentDigest === undefined
        ? base.pinDigests === true
          ? "pinDigest"
          : undefined
        : release.digest.startsWith(withSource.currentDigest)
          ? undefined
          : "digest";

    if (updateType === undefined) return undefined;

    const settings = settingsFor(policy, withSource, {
      ...context,
      updateType,
    });

    if (settings.enabled === false) return undefined;

    return {
      dependency: withSource,
      updateType,
      from:
        withSource.currentDigest === undefined
          ? withSource.currentValue
          : shortDigest(withSource.currentDigest),
      to: shortDigest(release.digest),
      settings,
      branch: branchFor(withSource, settings, updateType, next, false),
      lockfile: false,
      digest: release.digest,
    };
  };

  if (current === undefined) {
    // An image's tag that isn't a version, such as `latest`, only moves its
    // digest
    const release = docker
      ? metadata.releases.find((candidate) => candidate.version === tag)
      : undefined;

    if (release === undefined)
      return {
        updates: [],
        skipped: `can't read version ${withSource.currentValue}`,
      };

    const update = digestUpdate(release, undefined);

    return { updates: update === undefined ? [] : [update] };
  }

  const latest =
    metadata.latest === undefined
      ? undefined
      : parseVersion(metadata.latest, versioning);

  const best = new Map<string, Update & { readonly version: Version }>();
  let pending = 0;

  for (const release of metadata.releases) {
    const text = read(release);

    if (text === undefined) continue;

    if (precision !== undefined && partsOf(text) !== precision) continue;

    // Docker versioning keeps to tags with the same suffix, such as `-alpine`
    if (versioning === "docker" && !dockerCompatible(text, currentValue))
      continue;

    const next = parseVersion(text, versioning);

    if (next === undefined) continue;

    const order = compareVersions(next, current);

    if (order === 0) {
      const update = digestUpdate(release, next);

      if (update !== undefined)
        best.set(update.updateType, { ...update, version: next });

      continue;
    }

    if (order < 0) continue;

    if (allowedRange !== undefined && !semver.satisfies(text, allowedRange))
      continue;

    if (fixing !== undefined && compareVersions(next, fixing.version) < 0)
      continue;

    const updateType: UpdateType =
      next.parts[0] !== current.parts[0]
        ? "major"
        : next.parts[1] !== current.parts[1]
          ? "minor"
          : "patch";

    const own = settingsFor(policy, withSource, {
      ...context,
      updateType,
    });

    const settings =
      fixing === undefined ? own : { ...own, ...fixing.settings };

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
      locked !== undefined &&
      isRange(withSource.currentValue) &&
      semver.satisfies(text, withSource.currentValue);

    const key =
      fixing === undefined ? bucket(settings, updateType, next) : "fix";

    const previous = best.get(key);

    // A fix keeps one release: the first with it, or the newest
    if (
      previous !== undefined &&
      (fixing?.strategy === "lowest"
        ? compareVersions(previous.version, next) <= 0
        : compareVersions(previous.version, next) >= 0)
    )
      continue;

    best.set(key, {
      dependency: withSource,
      updateType,
      from:
        compatible === undefined
          ? (currentText ?? withSource.currentValue)
          : withSource.currentValue,
      to:
        compatible === undefined
          ? text
          : `${text}${compatible.compatibility ?? ""}`,
      settings,
      branch:
        fixing === undefined
          ? branchFor(withSource, settings, updateType, next, lockfile)
          : vulnerabilityBranch(withSource, settings, updateType, next),
      lockfile,
      // A pinned digest moves with the version, and pinDigests pins an image's
      digest:
        withSource.currentDigest !== undefined ||
        (docker && base.pinDigests === true)
          ? release.digest
          : undefined,
      vulnerable: fixing === undefined ? undefined : true,
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
  const settings = settingsFor(policy, withSource, context);

  // An image's tags follow Renovate's docker versioning unless a rule says
  const base =
    withSource.datasource === "docker" &&
    (settings.versioning === undefined || settings.versioning === null)
      ? { ...settings, versioning: "docker" }
      : settings;

  if (base.enabled === false) return { updates: [], skipped: "disabled" };

  const plan = versionUpdates(
    policy,
    withSource,
    metadata,
    now,
    base,
    context,
    fixFor(policy, withSource, base.versioning),
  );

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
