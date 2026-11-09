/**
 * Reading what changed between a repository's last stable release and its
 * branch, from Git objects alone: each net file change, the dependencies and
 * metadata behind a manifest or Bun lockfile change, Go requirements, and
 * the upstream changes behind a submodule pin a policy knows. Commit subjects
 * are traced to the content still in each change when an override asks for
 * them. Ported from `dot git releases`, hashing evidence the same way.
 */
import { Domain } from "@upkeep/api";
import { canonical, evidenceId } from "@upkeep/api/releases";
import {
  Cause,
  Effect,
  FileSystem,
  Path,
  Predicate,
  Result,
  Schema,
} from "effect";
import { run } from "../Command";
import { reason } from "../Failure";
import {
  matches,
  separatelyPublished,
  systemBridgeBuildDependencies,
  type Settings,
} from "./Policy";

type Fact = Domain.ReleaseFact;

type JsonObject = Schema.JsonObject;

export class ReleaseError extends Schema.TaggedError<ReleaseError>()(
  "ReleaseError",
  { message: Schema.String },
) {}

const decodeObject = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Json),
);

/** Why something failed, in a line, a gh failure's from what gh printed. */
export const why = (error: Error) => reason(Cause.fail(error));

/** A fact whose ID follows what changed, not how it was read. */
export const releaseFact = (
  input: Omit<Fact, "id"> & { readonly id?: string },
): Fact => {
  const {
    id: _id,
    complete: _complete,
    subjects: _subjects,
    evidenceUrl: _evidenceUrl,
    changedLines: _changedLines,
    ...evidence
  } = input;

  return { ...input, id: evidenceId(evidence) };
};

const isObject = (value: Schema.Json | undefined): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

const object = (value: Schema.Json | undefined): JsonObject =>
  value === undefined ? {} : decodeObject(value);

const values = (source: JsonObject, field: string) => object(source[field]);

const dependencyFact = (
  path: string,
  name: string,
  role: Domain.DependencyRole,
  before: Schema.Json | undefined,
  after: Schema.Json | undefined,
  detail: string,
): Fact =>
  releaseFact({
    kind: "dependency",
    path,
    previousPath: null,
    changeType:
      before === undefined
        ? "added"
        : after === undefined
          ? "deleted"
          : "modified",
    before: before === undefined ? null : canonical(before),
    after: after === undefined ? null : canonical(after),
    dependency: name,
    role,
    submodule: null,
    subject: null,
    detail,
    complete: role !== "unknown",
  });

const buildDependency = (name: string, settings: Settings) =>
  settings.policy === "system-bridge" &&
  systemBridgeBuildDependencies.includes(name);

/** A `package.json` change as dependency changes by role and other metadata. */
export const manifestChanges = (
  path: string,
  before: string | null,
  after: string | null,
  settings: Settings,
): Array<Fact> => {
  const old = before === null ? {} : decodeObject(JSON.parse(before));
  const next = after === null ? {} : decodeObject(JSON.parse(after));
  const facts: Array<Fact> = [];

  const fields = [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ];

  for (const field of fields) {
    const a = values(old, field);
    const b = values(next, field);

    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (canonical(a[name]) === canonical(b[name])) continue;

      const runtime = [old, next].some(
        (manifest) =>
          name in values(manifest, "dependencies") ||
          name in values(manifest, "optionalDependencies"),
      );

      const role: Domain.DependencyRole =
        field === "peerDependencies"
          ? "peer"
          : field !== "devDependencies" || runtime
            ? "runtime"
            : buildDependency(name, settings)
              ? "build"
              : "development";

      facts.push(
        dependencyFact(path, name, role, a[name], b[name], `${field}: ${name}`),
      );
    }
  }

  for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
    if (fields.includes(key) || canonical(old[key]) === canonical(next[key]))
      continue;

    facts.push(
      releaseFact({
        kind: "metadata",
        path,
        previousPath: null,
        changeType: "modified",
        before: canonical(old[key]),
        after: canonical(next[key]),
        dependency: null,
        role: null,
        submodule: null,
        subject: null,
        detail: `Package metadata: ${key}`,
        complete: true,
      }),
    );
  }

  return facts;
};

interface LockGraph {
  readonly packages: JsonObject;
  readonly roles: ReadonlyMap<string, Domain.DependencyRole>;
  readonly errors: ReadonlyArray<string>;
}

const rank: Record<Domain.DependencyRole, number> = {
  unknown: 0,
  development: 1,
  peer: 2,
  build: 3,
  runtime: 4,
};

/** A Bun lockfile's packages, and the strongest role each is reached by. */
const lockGraph = (source: string | null, settings: Settings): LockGraph => {
  if (source === null) return { packages: {}, roles: new Map(), errors: [] };

  const lock = decodeObject(Bun.JSONC.parse(source));

  if (lock["lockfileVersion"] !== 1 && lock["lockfileVersion"] !== 2)
    throw new Error("Unsupported Bun lockfile version");

  const packages = values(lock, "packages");
  const workspaces = values(lock, "workspaces");

  if (Object.keys(workspaces).length === 0)
    throw new Error("Bun lockfile has no workspace dependency roots");

  const roles = new Map<string, Domain.DependencyRole>();
  const errors = new Set<string>();
  const queue: Array<{ key: string; role: Domain.DependencyRole }> = [];

  const resolve = (name: string, parent: string) => {
    for (
      let scope = parent;
      scope !== "";
      scope = scope.includes("/") ? scope.slice(0, scope.lastIndexOf("/")) : ""
    ) {
      if (`${scope}/${name}` in packages) return `${scope}/${name}`;
    }

    return name in packages ? name : undefined;
  };

  const enqueue = (
    name: string,
    parent: string,
    role: Domain.DependencyRole,
    optional: boolean,
  ) => {
    const key = resolve(name, parent);

    if (key === undefined) {
      if (!optional)
        errors.add(
          `Unresolved Bun dependency ${name} from ${parent === "" ? "root" : parent}`,
        );

      return;
    }

    if (rank[roles.get(key) ?? "unknown"] >= rank[role]) return;

    roles.set(key, role);
    queue.push({ key, role });
  };

  for (const [workspace, value] of Object.entries(workspaces)) {
    const manifest = object(value);

    for (const field of [
      "dependencies",
      "optionalDependencies",
      "devDependencies",
    ]) {
      for (const name of Object.keys(values(manifest, field)))
        enqueue(
          name,
          workspace,
          field === "devDependencies"
            ? buildDependency(name, settings)
              ? "build"
              : "development"
            : "runtime",
          field === "optionalDependencies",
        );
    }
  }

  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];

    if (item === undefined) continue;

    const { key, role } = item;
    const record = packages[key];

    const fields: ReadonlyArray<Schema.Json> = Array.isArray(record)
      ? record
      : [];

    const [locator, second, third] = fields;

    if (!Predicate.isString(locator))
      throw new Error(`Invalid Bun package record: ${key}`);

    const workspacePath = locator.split("@workspace:")[1];
    let metadata: JsonObject;

    if (workspacePath !== undefined)
      metadata = object(workspaces[workspacePath]);
    else if (locator.includes("@github:")) {
      if (!isObject(second) || !Predicate.isString(third))
        throw new Error(`Invalid Bun package record: ${key}`);

      metadata = second;
    } else {
      if (!Predicate.isString(second) || !isObject(third))
        throw new Error(`Invalid Bun package record: ${key}`);

      metadata = third;
    }

    for (const field of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const name of Object.keys(values(metadata, field))) {
        const optionalPeers = metadata["optionalPeers"];

        const optional =
          field === "optionalDependencies" ||
          (field === "peerDependencies" &&
            Array.isArray(optionalPeers) &&
            optionalPeers.includes(name));

        enqueue(name, key, role, optional);
      }
    }
  }

  return { packages, roles, errors: [...errors] };
};

/** A locked package's resolution, without its integrity hash. */
const lockedValue = (record: Schema.Json | undefined) => {
  if (record === undefined) return undefined;

  if (!Array.isArray(record)) throw new Error("Invalid Bun package record");

  return record.slice(0, 3);
};

/** A lockfile-only change, by whether the old or new graph reaches each package. */
export const bunLockChanges = (
  path: string,
  before: string | null,
  after: string | null,
  settings: Settings,
) => {
  const old = lockGraph(before, settings);
  const next = lockGraph(after, settings);
  const facts: Array<Fact> = [];
  const errors = [...new Set([...old.errors, ...next.errors])];

  for (const key of new Set([
    ...Object.keys(old.packages),
    ...Object.keys(next.packages),
  ])) {
    const a = lockedValue(old.packages[key]);
    const b = lockedValue(next.packages[key]);

    if (canonical(a) === canonical(b)) continue;

    const roles = [old.roles.get(key), next.roles.get(key)];

    const role: Domain.DependencyRole = roles.includes("runtime")
      ? "runtime"
      : roles.includes("build")
        ? "build"
        : roles.includes("development") && errors.length === 0
          ? "development"
          : "unknown";

    const record = next.packages[key] ?? old.packages[key];

    const first = Array.isArray(record) ? record[0] : undefined;
    const locator = Predicate.isString(first) ? first : key;

    const name = locator.slice(0, locator.lastIndexOf("@")) || key;

    facts.push(
      dependencyFact(path, name, role, a, b, `Locked package: ${key}`),
    );

    if (role === "unknown")
      errors.push(
        `Cannot establish runtime/development reachability for ${path}: ${key}`,
      );
  }

  return { facts, errors };
};

/** A `go.mod`'s directives, by what each is about. */
const goModule = (source: string | null) => {
  const result = new Map<string, string>();
  let block = "";

  for (const raw of (source ?? "").split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();

    if (line === "") continue;

    if (line === ")") {
      block = "";

      continue;
    }

    const start = /^(require|replace|exclude|retract|tool)\s*\($/.exec(line);

    if (start?.[1] !== undefined) {
      block = start[1];

      continue;
    }

    const fields: Array<string> = line.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
    const directive = block === "" ? fields.shift() : block;

    if (directive === undefined || fields.length === 0)
      throw new Error(`Unsupported go.mod line: ${line}`);

    if (directive === "replace") {
      const arrow = fields.indexOf("=>");

      if (arrow < 1 || arrow === fields.length - 1)
        throw new Error(`Invalid Go replacement: ${line}`);

      result.set(
        `replace ${fields.slice(0, arrow).join(" ")}`,
        fields.slice(arrow + 1).join(" "),
      );
    } else if (directive === "require" || directive === "exclude") {
      if (fields.length !== 2)
        throw new Error(`Invalid Go requirement: ${line}`);

      result.set(`${directive} ${fields[0]}`, fields[1] ?? "");
    } else
      result.set(
        `${directive} ${directive === "tool" || directive === "retract" ? fields.join(" ") : ""}`.trim(),
        fields.join(" "),
      );
  }

  if (block !== "") throw new Error("Unclosed go.mod block");

  return result;
};

/** A `go.mod` change as requirement, replacement and toolchain changes. */
export const goModuleChanges = (
  path: string,
  before: string | null,
  after: string | null,
): Array<Fact> => {
  const old = goModule(before);
  const next = goModule(after);

  return new Set([...old.keys(), ...next.keys()])
    .values()
    .filter((key) => old.get(key) !== next.get(key))
    .map((key) => {
      const [directive = key, name] = key.split(" ");

      return dependencyFact(
        path,
        name ?? directive,
        directive === "tool" ? "development" : "runtime",
        old.get(key),
        next.get(key),
        `Go ${key}`,
      );
    })
    .toArray();
};

/** What changed since a release, with every commit and what's missing. */
export interface Changes {
  readonly facts: ReadonlyArray<Fact>;
  /** Every net file change, classified or not. */
  readonly files: ReadonlyArray<Fact>;
  /** Every commit, with a known submodule's upstream commits. */
  readonly commits: ReadonlyArray<Domain.ReleaseCommit>;
  readonly errors: ReadonlyArray<string>;
}

/** Run Git in `cwd`, failing with what it said. */
export const git = (cwd: string, args: ReadonlyArray<string>) =>
  run("git", args, { cwd, trusted: cwd }).pipe(
    Effect.mapError(
      (error) => new ReleaseError({ message: reason(Cause.fail(error)) }),
    ),
  );

const parseRawDiff = (output: string, submodule: string | null) => {
  const parts = output.split("\0");
  const facts: Array<Fact> = [];

  for (let index = 0; index < parts.length && parts[index] !== "";) {
    const header = /^:(\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])\d*$/.exec(
      parts[index++] ?? "",
    );

    if (header === null) throw new Error("Could not parse Git raw diff");

    const [
      ,
      oldMode = "",
      newMode = "",
      oldObject = "",
      newObject = "",
      status = "",
    ] = header;

    const path = parts[index++];
    const renamed = status === "R";
    const nextPath = renamed ? parts[index++] : path;

    if (
      path === undefined ||
      path === "" ||
      nextPath === undefined ||
      nextPath === ""
    )
      throw new Error("Missing Git diff path");

    const prefix = submodule === null ? "" : `${submodule}/`;

    facts.push(
      releaseFact({
        kind:
          oldMode === "160000" || newMode === "160000" ? "submodule" : "file",
        path: prefix + nextPath,
        previousPath: renamed ? prefix + path : null,
        changeType: renamed
          ? "renamed"
          : status === "A"
            ? "added"
            : status === "D"
              ? "deleted"
              : "modified",
        before: /^0+$/.test(oldObject) ? null : `${oldMode}:${oldObject}`,
        after: /^0+$/.test(newObject) ? null : `${newMode}:${newObject}`,
        dependency: null,
        role: null,
        submodule,
        subject: null,
        detail: `${status} ${prefix}${nextPath}`,
        complete: true,
      }),
    );
  }

  return facts;
};

const parseLog = (output: string, submodule: string | null) => {
  const parts = output.split("\0");
  const commits: Array<Domain.ReleaseCommit> = [];

  for (let index = 0; index + 2 < parts.length; index += 3) {
    const id = (parts[index] ?? "").trim();

    if (!/^[a-f0-9]{40,64}$/.test(id))
      throw new Error("Invalid commit ID in Git log");

    commits.push({
      id,
      subject: parts[index + 1] ?? "",
      date: parts[index + 2] ?? "",
      submodule,
    });
  }

  return commits;
};

const parseNumstat = (output: string) => {
  const records = output.split("\0");
  const counts = new Map<string, number | null>();

  for (let index = 0; index < records.length && records[index] !== "";) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[index++] ?? "");

    if (match === null) throw new Error("Could not parse Git line counts");

    const [, added = "", removed = ""] = match;
    let path = match[3];

    if (path === undefined || path === "") {
      // A rename gives its old and new paths as records of their own
      index++;
      path = records[index++];
    }

    if (path === undefined || path === "")
      throw new Error("Missing Git line-count path");

    counts.set(
      path,
      added === "-" || removed === "-" ? null : Number(added) + Number(removed),
    );
  }

  return counts;
};

/** The diff base and log range; a first release compares the empty tree with everything. */
const baseline = Effect.fnUntraced(function* (
  cwd: string,
  before: string | null,
  after: string,
) {
  return {
    tree:
      before ??
      (yield* git(cwd, ["hash-object", "-t", "tree", "/dev/null"])).trim(),
    revisions: before === null ? after : `${before}..${after}`,
  };
});

const range = Effect.fnUntraced(function* (
  cwd: string,
  before: string | null,
  after: string,
  submodule: string | null,
) {
  const base = yield* baseline(cwd, before, after);

  const diff = yield* git(cwd, [
    "diff",
    "--raw",
    "-z",
    "--no-abbrev",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=none",
    "-M",
    base.tree,
    after,
    "--",
  ]);

  const log = yield* git(cwd, [
    "log",
    "-z",
    "--format=%H%x00%s%x00%cI",
    base.revisions,
    "--",
  ]);

  const numstat = yield* git(cwd, [
    "diff",
    "--numstat",
    "-z",
    "--no-ext-diff",
    "--no-textconv",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    "--ignore-submodules=none",
    "-M",
    base.tree,
    after,
    "--",
  ]);

  return yield* Effect.try({
    try: () => {
      const counts = parseNumstat(numstat);

      return {
        facts: parseRawDiff(diff, submodule).map((fact) => {
          const path =
            submodule === null
              ? fact.path
              : fact.path.slice(submodule.length + 1);

          if (!counts.has(path))
            throw new Error(`Missing Git line count for ${fact.path}`);

          return { ...fact, changedLines: counts.get(path) ?? null };
        }),
        commits: parseLog(log, submodule),
      };
    },
    catch: (error) => new ReleaseError({ message: reason(Cause.fail(error)) }),
  });
});

const blob = (cwd: string, value: string | null) =>
  value === null
    ? Effect.succeed(null)
    : git(cwd, ["cat-file", "blob", value.slice(value.indexOf(":") + 1)]);

const submoduleUrl = Effect.fnUntraced(function* (
  cwd: string,
  commit: string,
  path: string,
) {
  const output = yield* git(cwd, [
    "config",
    "--blob",
    `${commit}:.gitmodules`,
    "--get-regexp",
    "^submodule\\..*\\.(path|url)$",
  ]);

  const entries = output
    .trim()
    .split("\n")
    .map((line) => {
      const index = line.indexOf(" ");

      return [line.slice(0, index), line.slice(index + 1)] as const;
    });

  const name = entries
    .find(([key, value]) => key.endsWith(".path") && value === path)?.[0]
    .slice(0, -5);

  const url = entries.find(([key]) => key === `${name}.url`)?.[1];

  if (
    url === undefined ||
    !/^(https:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(
      url,
    )
  )
    return yield* new ReleaseError({
      message: `Missing or unsupported upstream URL for ${path}`,
    });

  return url;
});

interface ChangedLines {
  readonly added: ReadonlySet<number>;
  readonly removed: ReadonlySet<number>;
}

const changedLines = (diff: string): ChangedLines => {
  const added = new Set<number>();
  const removed = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);

    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
    } else if (inHunk && line.startsWith("-")) removed.add(oldLine++);
    else if (inHunk && line.startsWith("+")) added.add(newLine++);
    else if (inHunk && line.startsWith(" ")) {
      oldLine++;
      newLine++;
    } else if (!line.startsWith("\\")) inHunk = false;
  }

  return { added, removed };
};

const blameLines = (output: string) => {
  const lines: Array<{ readonly commit: string; readonly finalLine: number }> =
    [];

  for (const line of output.split("\n")) {
    const header = /^([a-f0-9]{40,64}) (\d+) (\d+)(?: \d+)?$/.exec(line);

    if (header?.[1] !== undefined)
      lines.push({ commit: header[1], finalLine: Number(header[3]) });
  }

  return lines;
};

/**
 * Trace each change an override with `subjects` could match to the commits
 * whose content is still in it: the commits behind each surviving added
 * line, and those that removed each line still gone, or for a dependency or
 * metadata value, those that set the value it has now. Only done when one of
 * the commits' subjects matches such an override.
 */
export const attributeSubjects = Effect.fnUntraced(function* (
  cwd: string,
  before: string | null,
  after: string,
  facts: ReadonlyArray<Fact>,
  commits: ReadonlyArray<Domain.ReleaseCommit>,
  settings: Settings,
  submodule: string | null = null,
) {
  const rules = settings.overrides.filter(
    (rule) => rule.subjects !== undefined,
  );

  if (
    rules.length === 0 ||
    !commits.some((commit) =>
      rules.some((rule) =>
        rule.subjects?.some((pattern) =>
          new RegExp(pattern).test(commit.subject),
        ),
      ),
    )
  )
    return facts;

  const base = yield* baseline(cwd, before, after);

  const graph = new Map(
    (yield* git(cwd, ["rev-list", "--parents", base.revisions]))
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [commit = "", ...parents] = line.split(" ");

        return [commit, parents] as const;
      }),
  );

  const trees = new Map<string, string | null>();
  const sources = new Map<string, string | null>();
  const structured = new Map<string, ReadonlyArray<Fact>>();
  const diffs = new Map<string, ChangedLines>();

  const gitPath = (path: string) =>
    submodule === null ? path : path.slice(submodule.length + 1);

  const tree = Effect.fnUntraced(function* (commit: string, path: string) {
    const key = `${commit}:${path}`;

    if (trees.has(key)) return trees.get(key) ?? null;

    const output = yield* git(cwd, [
      "ls-tree",
      "-z",
      commit,
      "--",
      `:(literal)${gitPath(path)}`,
    ]);

    const record = /^(\d+) (?:blob|commit) ([a-f0-9]+)\t/.exec(output);
    const value = record === null ? null : `${record[1]}:${record[2]}`;

    trees.set(key, value);

    return value;
  });

  const source = Effect.fnUntraced(function* (commit: string, path: string) {
    const key = `${commit}:${path}`;

    if (sources.has(key)) return sources.get(key) ?? null;

    const value = yield* blob(cwd, yield* tree(commit, path));

    sources.set(key, value);

    return value;
  });

  const value = Effect.fnUntraced(function* (commit: string, fact: Fact) {
    if (fact.kind !== "dependency" && fact.kind !== "metadata")
      return yield* tree(commit, fact.path);

    const key = `${commit}:${fact.path}`;

    if (!structured.has(key)) {
      const text = yield* source(commit, fact.path);

      const parsed = yield* Effect.try({
        try: () =>
          fact.path.endsWith("package.json")
            ? manifestChanges(fact.path, null, text, settings)
            : fact.path.endsWith("bun.lock")
              ? bunLockChanges(fact.path, null, text, settings).facts
              : goModuleChanges(fact.path, null, text),
        catch: (error) =>
          new ReleaseError({
            message: `Cannot attribute ${fact.path} at ${commit}: ${reason(Cause.fail(error))}`,
          }),
      });

      structured.set(key, parsed);
    }

    return (
      structured
        .get(key)
        ?.find(
          (candidate) =>
            candidate.detail === fact.detail &&
            candidate.kind === fact.kind &&
            candidate.dependency === fact.dependency,
        )?.after ?? (fact.kind === "metadata" ? "undefined" : null)
    );
  });

  const valueOwners = Effect.fnUntraced(function* (fact: Fact) {
    const expected = yield* value(after, fact);
    const owners = new Set<string>();
    const pending = [after];
    const visited = new Set<string>();

    for (let index = 0; index < pending.length; index++) {
      const commit = pending[index] ?? "";

      if (visited.has(commit) || !graph.has(commit)) continue;

      visited.add(commit);

      const inherited: Array<string> = [];

      for (const parent of graph.get(commit) ?? [])
        if ((yield* value(parent, fact)) === expected) inherited.push(parent);

      if (inherited.length > 0) pending.push(...inherited);
      else owners.add(commit);
    }

    return owners;
  });

  const lineDiff = Effect.fnUntraced(function* (
    old: string,
    next: string,
    path: string,
    previousPath: string | null = null,
  ) {
    const key = `${old}:${next}:${path}:${previousPath ?? ""}`;
    const cached = diffs.get(key);

    if (cached !== undefined) return cached;

    const output = yield* git(cwd, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--diff-algorithm=myers",
      "--no-indent-heuristic",
      "--unified=0",
      "--inter-hunk-context=0",
      "-M",
      old,
      next,
      "--",
      `:(literal)${gitPath(path)}`,
      ...(previousPath === null ? [] : [`:(literal)${gitPath(previousPath)}`]),
    ]);

    const result = changedLines(output);

    diffs.set(key, result);

    return result;
  });

  const blame = Effect.fnUntraced(function* (commit: string, path: string) {
    const output = yield* git(cwd, [
      "blame",
      "--root",
      "--line-porcelain",
      "--diff-algorithm=myers",
      "--ignore-revs-file",
      "",
      commit,
      "--",
      gitPath(path),
    ]);

    return yield* Effect.try({
      try: () => blameLines(output),
      catch: (error) =>
        new ReleaseError({
          message: `Cannot read source lineage for ${path}: ${reason(Cause.fail(error))}`,
        }),
    });
  });

  const removalOwners = Effect.fnUntraced(function* (fact: Fact, line: number) {
    const owners = new Set<string>();
    const pending = [after];
    const visited = new Set<string>();

    for (let index = 0; index < pending.length; index++) {
      const commit = pending[index] ?? "";

      if (visited.has(commit) || !graph.has(commit)) continue;

      visited.add(commit);

      const inherited: Array<string> = [];

      // Each parent is compared with the baseline, so a restored line ends
      // the old removal's lineage
      for (const parent of graph.get(commit) ?? [])
        if (
          (yield* lineDiff(
            base.tree,
            parent,
            fact.path,
            fact.previousPath,
          )).removed.has(line)
        )
          inherited.push(parent);

      if (inherited.length > 0) pending.push(...inherited);
      else owners.add(commit);
    }

    return owners;
  });

  const owners = Effect.fnUntraced(function* (fact: Fact) {
    if (fact.kind === "dependency" || fact.kind === "metadata")
      return yield* valueOwners(fact);

    const net = yield* lineDiff(base.tree, after, fact.path, fact.previousPath);

    if (net.added.size === 0 && net.removed.size === 0)
      return yield* valueOwners(fact);

    const found = new Set<string>();

    if (net.added.size > 0) {
      const added = yield* blame(after, fact.path);

      if (
        [...net.added].some(
          (line) => !added.some((entry) => entry.finalLine === line),
        )
      )
        return yield* new ReleaseError({
          message: `Incomplete added-line lineage for ${fact.path}`,
        });

      for (const line of added)
        if (net.added.has(line.finalLine)) found.add(line.commit);
    }

    for (const line of net.removed)
      for (const owner of yield* removalOwners(fact, line)) found.add(owner);

    return found;
  });

  const attributed: Array<Fact> = [];

  for (const fact of facts) {
    if (
      !fact.complete ||
      !rules.some((rule) => {
        const { subjects: _subjects, ...rest } = rule;

        return matches(rest, fact);
      })
    ) {
      attributed.push(fact);

      continue;
    }

    const result = yield* owners(fact).pipe(Effect.result);

    attributed.push(
      Result.isSuccess(result)
        ? {
            ...fact,
            subjects: [
              ...new Set(
                commits
                  .values()
                  .filter((commit) => result.success.has(commit.id))
                  .map((commit) => commit.subject),
              ),
            ].toSorted(),
          }
        : {
            ...fact,
            complete: false,
            detail: `${fact.detail}: ${result.failure.message}`,
          },
    );
  }

  return attributed;
});

/** A GitHub page of a submodule's upstream. */
const webUrl = (url: string) =>
  url.replace(/^git@github.com:/, "https://github.com/").replace(/\.git$/, "");

/**
 * The upstream changes behind a submodule pin, from a bare clone of its
 * upstream in `cacheDirectory`. Only a policy that knows the submodule's
 * shipped content reads it; any other pin needs a rule or a review.
 */
const submoduleChanges = Effect.fnUntraced(function* (
  cwd: string,
  before: string | null,
  after: string,
  fact: Fact,
  settings: Settings,
  cacheDirectory: string,
) {
  if (fact.path !== "vendor/anti-slop" || settings.policy !== "oxlint-rules")
    return yield* new ReleaseError({
      message: `No upstream shipped-content policy for ${fact.path}`,
    });

  if (fact.before === null || fact.after === null || before === null)
    return yield* new ReleaseError({
      message: `Submodule added or removed: ${fact.path}; upstream comparison needs review`,
    });

  const oldUrl = yield* submoduleUrl(
    cwd,
    before,
    fact.previousPath ?? fact.path,
  );

  const url = yield* submoduleUrl(cwd, after, fact.path);

  if (url !== oldUrl)
    return yield* new ReleaseError({
      message: `Submodule URL changed: ${fact.path}; upstream comparison needs review`,
    });

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const directory = path.join(
    cacheDirectory,
    "upstream",
    evidenceId(fact.path),
  );

  if (!(yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false)))) {
    yield* fs
      .makeDirectory(path.dirname(directory), { recursive: true })
      .pipe(
        Effect.mapError((error) => new ReleaseError({ message: why(error) })),
      );
    yield* git(cwd, ["init", "--quiet", "--bare", directory]);
  }

  const oldCommit = fact.before.split(":")[1] ?? "";
  const nextCommit = fact.after.split(":")[1] ?? "";

  yield* git(directory, [
    "fetch",
    "--quiet",
    "--no-write-fetch-head",
    "--no-tags",
    "--no-recurse-submodules",
    url,
    `+${oldCommit}:refs/upkeep-release/base`,
    `+${nextCommit}:refs/upkeep-release/head`,
  ]);

  const upstream = yield* range(directory, oldCommit, nextCommit, fact.path);
  const page = webUrl(url);

  return {
    evidenceUrl: `${page}/compare/${oldCommit}...${nextCommit}`,
    commits: upstream.commits.map((commit) => ({
      ...commit,
      url: `${page}/commit/${commit.id}`,
    })),
    facts: yield* attributeSubjects(
      directory,
      oldCommit,
      nextCommit,
      upstream.facts,
      upstream.commits,
      settings,
      fact.path,
    ),
  };
});

const structuredPath = (path: string) =>
  ["package.json", "bun.lock", "go.mod"].some(
    (name) => path === name || path.endsWith(`/${name}`),
  );

/** A manifest, Bun lockfile or `go.mod` change, read as what it changes. */
const structuredChanges = Effect.fnUntraced(function* (
  cwd: string,
  fact: Fact,
  settings: Settings,
) {
  const old = yield* blob(cwd, fact.before);
  const next = yield* blob(cwd, fact.after);

  return yield* Effect.try({
    try: () =>
      fact.path.endsWith("package.json")
        ? {
            facts: manifestChanges(fact.path, old, next, settings),
            errors: [],
          }
        : fact.path.endsWith("bun.lock")
          ? bunLockChanges(fact.path, old, next, settings)
          : { facts: goModuleChanges(fact.path, old, next), errors: [] },
    catch: (error) =>
      new ReleaseError({
        message: `${fact.path}: ${reason(Cause.fail(error))}`,
      }),
  });
});

/**
 * Everything that changed from `before`, the release commit, or the start
 * of history, to `after`, without checking a file out. Quiet and incomplete
 * changes are kept, and what couldn't be read is in `errors`.
 */
export const collect = Effect.fnUntraced(function* (
  cwd: string,
  before: string | null,
  after: string,
  settings: Settings,
  cacheDirectory: string,
) {
  const comparison = yield* range(cwd, before, after, null);
  const facts: Array<Fact> = [];
  const commits = [...comparison.commits];
  const errors: Array<string> = [];

  for (const fact of comparison.facts) {
    if (
      separatelyPublished(fact.path, settings.policy) &&
      (fact.previousPath === null ||
        separatelyPublished(fact.previousPath, settings.policy))
    ) {
      facts.push(fact);

      continue;
    }

    if (fact.kind === "submodule") {
      const pin = { ...fact, submodule: fact.path };

      if (
        settings.overrides.find((rule) => matches(rule, pin))?.submodules !==
        undefined
      ) {
        facts.push(pin);

        continue;
      }

      const upstream = yield* submoduleChanges(
        cwd,
        before,
        after,
        fact,
        settings,
        cacheDirectory,
      ).pipe(Effect.result);

      if (Result.isSuccess(upstream)) {
        const { evidenceUrl } = upstream.success;

        facts.push(
          { ...pin, evidenceUrl },
          ...upstream.success.facts.map((finding) => ({
            ...finding,
            evidenceUrl,
          })),
        );
        commits.push(...upstream.success.commits);
      } else {
        facts.push({ ...pin, complete: false });
        errors.push(upstream.failure.message);
      }

      continue;
    }

    if (structuredPath(fact.path)) {
      if (fact.previousPath !== null) facts.push(fact);

      const parsed = yield* structuredChanges(cwd, fact, settings).pipe(
        Effect.result,
      );

      if (Result.isFailure(parsed)) {
        facts.push({ ...fact, complete: false });
        errors.push(parsed.failure.message);
      } else {
        facts.push(...parsed.success.facts);
        errors.push(...parsed.success.errors);

        if (parsed.success.facts.length === 0)
          facts.push({
            ...fact,
            kind: "checksum",
            detail: `Formatting or checksum-only change: ${fact.path}`,
          });
      }
    } else
      facts.push(
        fact.path.endsWith("go.sum")
          ? { ...fact, kind: "checksum" }
          : fact.path.endsWith("bun.lockb")
            ? {
                ...fact,
                complete: false,
                detail:
                  "Binary Bun lockfile cannot be classified; text lockfile evidence required",
              }
            : fact,
      );
  }

  const local = yield* attributeSubjects(
    cwd,
    before,
    after,
    facts.filter((fact) => fact.submodule === null),
    comparison.commits,
    settings,
  );

  const byId = new Map(local.map((fact) => [fact.id, fact]));
  const attributed = facts.map((fact) => byId.get(fact.id) ?? fact);

  for (const fact of attributed)
    if (!fact.complete && !errors.includes(fact.detail))
      errors.push(fact.detail);

  return {
    facts: attributed,
    files: [
      ...comparison.facts,
      ...attributed.filter(
        (fact) => fact.submodule !== null && fact.kind !== "submodule",
      ),
    ],
    commits,
    errors,
  } satisfies Changes;
});
