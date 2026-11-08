/**
 * Lockfiles: the version a package.json's npm dependencies are locked at,
 * read from bun.lock, pnpm-lock.yaml, package-lock.json or yarn.lock the way
 * Renovate's npm manager reads its lockfiles, so a range can move within
 * itself. Renovate's bun manager reads no versions, so bun.lock goes further.
 */
import semver from "semver";
import { Predicate, Schema } from "effect";
import { Yaml } from "effect/encoding";

/** The lockfiles read, in the order the job installs with them. */
export const names = [
  "bun.lock",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
] as const;

/** The dependency types a lockfile pins for a package. */
export const lockedTypes: ReadonlySet<string> = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
]);

/**
 * A lockfile's locked version of one dependency: of the package.json in
 * `directory`, relative to the lockfile's own, by its type, name and the
 * value package.json gives it.
 */
export type Locked = (
  directory: string,
  depType: string,
  depName: string,
  value: string,
) => string | undefined;

const dirname = (file: string) =>
  file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";

/** The nearest lockfile at or above a package.json. */
export const nearest = (file: string, files: ReadonlyMap<string, string>) => {
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    const found = names
      .map((name) => (directory === "" ? name : `${directory}/${name}`))
      .find((lock) => files.has(lock));

    if (found !== undefined) return found;

    if (directory === "") return undefined;
  }
};

/** A package.json's directory relative to its lockfile's, `""` at its root. */
export const relative = (file: string, lockfile: string) => {
  const directory = dirname(file);
  const root = dirname(lockfile);

  return root === "" ? directory : directory.slice(root.length + 1);
};

const valid = (version: string | undefined) =>
  version === undefined ? undefined : (semver.valid(version) ?? undefined);

const BunLock = Schema.Struct({
  workspaces: Schema.Record(
    Schema.String,
    Schema.Struct({ name: Schema.optional(Schema.String) }),
  ),
  packages: Schema.optional(
    Schema.Record(Schema.String, Schema.Array(Schema.Unknown)),
  ),
});

/**
 * bun.lock, JSONC: each workspace by its path, and each package by its name,
 * or by its workspace's name and its own where the workspace has its own
 * copy. Its first entry is `name@version`.
 */
const bunLock = (text: string): Locked => {
  const lock = Schema.decodeUnknownSync(BunLock)(Bun.JSONC.parse(text));

  return (directory, _depType, depName) => {
    const workspace = lock.workspaces[directory]?.name;

    const own =
      workspace === undefined
        ? undefined
        : lock.packages?.[`${workspace}/${depName}`];

    const entry = (own ?? lock.packages?.[depName])?.[0];

    return Predicate.isString(entry)
      ? valid(entry.slice(entry.lastIndexOf("@") + 1))
      : undefined;
  };
};

const PnpmVersion = Schema.Union([
  Schema.String,
  Schema.Struct({ version: Schema.optional(Schema.String) }),
]);

const PnpmImporter = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, PnpmVersion)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, PnpmVersion)),
  optionalDependencies: Schema.optional(
    Schema.Record(Schema.String, PnpmVersion),
  ),
});

const PnpmLock = Schema.Struct({
  ...PnpmImporter.fields,
  importers: Schema.optional(Schema.Record(Schema.String, PnpmImporter)),
});

/**
 * pnpm-lock.yaml: each workspace by its path, `.` at the root, or the root
 * alone at the top level before workspaces. A version carries its peers in
 * brackets, and the main lockfile is the last YAML document.
 */
const pnpmLock = (text: string): Locked => {
  const lock = Schema.decodeUnknownSync(PnpmLock)(
    Yaml.parse(text.split(/^---\s*$/m).at(-1) ?? ""),
  );

  return (directory, depType, depName) => {
    const importer =
      lock.importers === undefined
        ? directory === ""
          ? lock
          : undefined
        : lock.importers[directory === "" ? "." : directory];

    const entry =
      depType === "dependencies" ||
      depType === "devDependencies" ||
      depType === "optionalDependencies"
        ? importer?.[depType]?.[depName]
        : undefined;

    const version = Predicate.isString(entry) ? entry : entry?.version;

    return valid(version?.split("(")[0]?.trim());
  };
};

const NpmPackage = Schema.Struct({ version: Schema.optional(Schema.String) });

const PackageLock = Schema.Struct({
  packages: Schema.optional(Schema.Record(Schema.String, NpmPackage)),
  dependencies: Schema.optional(Schema.Record(Schema.String, NpmPackage)),
});

/**
 * package-lock.json: each installed package by its path, where Node would
 * resolve it from the workspace, its own node_modules then the root's.
 * Version 1 lockfiles list the root's dependencies alone.
 */
const packageLock = (text: string): Locked => {
  const lock = Schema.decodeUnknownSync(PackageLock)(JSON.parse(text));

  return (directory, _depType, depName) => {
    if (lock.packages === undefined)
      return directory === ""
        ? valid(lock.dependencies?.[depName]?.version)
        : undefined;

    const paths = [
      ...(directory === "" ? [] : [`${directory}/node_modules/${depName}`]),
      `node_modules/${depName}`,
    ];

    return valid(
      paths
        .map((path) => lock.packages?.[path]?.version)
        .find((version) => version !== undefined),
    );
  };
};

/**
 * yarn.lock, Yarn 1 or Berry: entries keyed by every `name@range` they
 * resolve, Berry's ranges with an `npm:` protocol, then an indented version.
 */
const yarnLock = (text: string): Locked => {
  const versions = new Map<string, string>();
  let keys: ReadonlyArray<string> = [];

  for (const line of text.split("\n")) {
    if (/^[^\s#].*:$/.test(line)) {
      keys = line
        .slice(0, -1)
        .split(/,\s*/)
        .map((key) => key.replace(/^"|"$/g, ""));

      continue;
    }

    const version = /^ {2}version:? "?(?<version>[^"\s]+)"?\s*$/.exec(line)
      ?.groups?.version;

    if (version === undefined) continue;

    for (const key of keys) {
      const at = key.indexOf("@", 1);

      if (at > 0)
        versions.set(
          `${key.slice(0, at)}@${key.slice(at + 1).replace(/^npm:/, "")}`,
          version,
        );
    }

    keys = [];
  }

  return (_directory, _depType, depName, value) =>
    valid(versions.get(`${depName}@${value.replace(/^npm:/, "")}`));
};

/**
 * Read a lockfile by its name, none for one it doesn't read. Throws when it
 * can't be parsed.
 */
export const read = (lockfile: string, text: string): Locked | undefined => {
  switch (lockfile.split("/").at(-1)) {
    case "bun.lock":
      return bunLock(text);
    case "pnpm-lock.yaml":
      return pnpmLock(text);
    case "package-lock.json":
      return packageLock(text);
    case "yarn.lock":
      return yarnLock(text);
    default:
      return undefined;
  }
};
