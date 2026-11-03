/**
 * The managers: find the dependencies in a repository's files, read from
 * their text without running a package manager. npm and Bun read
 * package.json beside a bun.lock, mise reads its TOML configs, GitHub
 * Actions reads workflows and actions, and custom regex managers read
 * whatever files a policy points them at.
 */
import { Option, Predicate, Schema } from "effect";
import { Yaml } from "effect/encoding";
import type { CustomManager, Dependency, Policy } from "./Policy";
import { matchesPattern } from "./Rules";

/** Files each manager reads, as Renovate's default managerFilePatterns. */
const filePatterns = {
  npm: ["/(^|/)package\\.json$/"],
  mise: [
    "/(^|/)\\.?mise\\.toml$/",
    "/(^|/)\\.?mise/config\\.toml$/",
    "/(^|/)\\.config/mise\\.toml$/",
    "/(^|/)\\.config/mise/config\\.toml$/",
    "/(^|/)\\.rtx\\.toml$/",
  ],
  "github-actions": [
    "/(^|/)(workflow-templates|\\.(?:github|gitea|forgejo)/(?:workflows|actions))/.+\\.ya?ml$/",
    "/(^|/)action\\.ya?ml$/",
  ],
};

/** What extraction found, with what it couldn't read. */
export interface Extraction {
  readonly dependencies: ReadonlyArray<Dependency>;
  readonly notes: ReadonlyArray<string>;
}

/** Whether a policy's ignorePaths leave a file out, as globs or substrings. */
const ignored = (policy: Policy, file: string) =>
  policy.ignorePaths.some(
    (pattern) => file.includes(pattern) || matchesPattern(file, pattern),
  );

const enabled = (policy: Policy, manager: string) =>
  policy.enabledManagers.length === 0 ||
  policy.enabledManagers.includes(manager) ||
  (manager === "bun" && policy.enabledManagers.includes("npm"));

/** Whether a file matches a list of managerFilePatterns. */
const matchesFiles = (file: string, patterns: ReadonlyArray<string>) =>
  patterns.some((pattern) => matchesPattern(file, pattern));

/** The files of a repository's tree that any manager would read. */
export const wanted = (policy: Policy, tree: ReadonlyArray<string>) =>
  tree.filter(
    (file) =>
      !ignored(policy, file) &&
      (/(^|\/)bun\.lockb?$/.test(file) ||
        Object.values(filePatterns).some((patterns) =>
          matchesFiles(file, patterns),
        ) ||
        policy.customManagers.some((manager) =>
          matchesFiles(file, manager.files),
        )),
  );

const dirname = (file: string) =>
  file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";

/** The nearest bun.lock at or above a package.json, which pins its workspace. */
const bunLock = (file: string, files: ReadonlyMap<string, string>) => {
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    const lock = directory === "" ? "bun.lock" : `${directory}/bun.lock`;

    if (files.has(lock)) return lock;

    if (directory === "") return undefined;
  }
};

/** The version bun.lock resolved each package to, by name. */
const bunVersions = (text: string) => {
  const versions = new Map<string, string>();
  const lock: unknown = Bun.JSON5.parse(text);

  if (!Predicate.isObject(lock) || !("packages" in lock)) return versions;

  const packages = lock.packages;

  if (!Predicate.isObject(packages)) return versions;

  for (const [name, entry] of Object.entries(packages)) {
    const resolution: unknown = Array.isArray(entry) ? entry[0] : undefined;

    if (Predicate.isString(resolution))
      versions.set(name, resolution.slice(resolution.lastIndexOf("@") + 1));
  }

  return versions;
};

const dependencyTypes = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
  "resolutions",
] as const;

/** One package.json entry: an npm package, an npm alias or a GitHub ref. */
const packageDependency = (
  manager: string,
  file: string,
  depName: string,
  value: string,
  depType: string,
): Dependency => {
  const github =
    /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/|git@github\.com:)(?<repo>[^#]+?)(?:\.git)?(?:#(?<ref>.+))?$/.exec(
      value,
    )?.groups;

  if (github?.repo !== undefined) {
    const ref = github.ref ?? "HEAD";

    return {
      manager,
      file,
      depName,
      packageName: github.repo,
      datasource: /^v?\d+\.\d+\.\d+/.test(ref) ? "github-tags" : "git-refs",
      depType,
      currentValue: ref,
      currentDigest: /^[a-f\d]{7,40}$/i.test(ref) ? ref : undefined,
      sourceUrl: `https://github.com/${github.repo}`,
    };
  }

  const alias = /^npm:(?<name>.+)@(?<version>[^@]+)$/.exec(value)?.groups;

  return {
    manager,
    file,
    depName,
    packageName: alias?.name ?? depName,
    datasource: /^(?:workspace:|file:|link:|catalog:)/.test(value)
      ? "local"
      : "npm",
    depType,
    currentValue: alias?.version ?? value,
  };
};

/** The parts of a package.json that list dependencies. */
const PackageJson = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  optionalDependencies: Schema.optional(
    Schema.Record(Schema.String, Schema.Json),
  ),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  resolutions: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  packageManager: Schema.optional(Schema.Json),
});

const decodePackageJson = Schema.decodeUnknownOption(PackageJson);

const extractPackage = (
  file: string,
  text: string,
  files: ReadonlyMap<string, string>,
): Extraction => {
  const decoded = decodePackageJson(JSON.parse(text));

  if (Option.isNone(decoded))
    return { dependencies: [], notes: [`${file} couldn't be read`] };

  const manifest = decoded.value;
  const lock = bunLock(file, files);
  const manager = lock === undefined ? "npm" : "bun";

  const locked =
    lock === undefined ? new Map() : bunVersions(files.get(lock) ?? "");

  const dependencies: Array<Dependency> = [];
  const notes: Array<string> = [];

  for (const depType of dependencyTypes) {
    const entries = manifest[depType];

    if (entries === undefined) continue;

    for (const [depName, value] of Object.entries(entries)) {
      if (!Predicate.isString(value)) {
        notes.push(`${file}: nested ${depType} for ${depName} aren't read`);

        continue;
      }

      // A `$name` override follows the dependency it names
      if (value.startsWith("$")) continue;

      const dependency = packageDependency(
        manager,
        file,
        depName,
        value,
        depType,
      );

      const version = locked.get(depName);

      dependencies.push({
        ...dependency,
        lockFiles: lock === undefined ? undefined : [lock],
        lockedVersion: dependency.datasource === "npm" ? version : undefined,
      });
    }
  }

  const packageManager = manifest.packageManager;

  if (Predicate.isString(packageManager)) {
    const parsed = /^(?<name>[\w@./-]+)@(?<version>[^+]+)/.exec(
      packageManager,
    )?.groups;

    if (parsed?.name !== undefined && parsed.version !== undefined)
      dependencies.push({
        manager,
        file,
        depName: parsed.name,
        packageName: parsed.name,
        datasource: "npm",
        depType: "packageManager",
        currentValue: parsed.version,
      });
  }

  return { dependencies, notes };
};

/** GitHub repositories of mise's core and common tools, which it doesn't name. */
const upstreams = new Map([
  ["bun", "oven-sh/bun"],
  ["deno", "denoland/deno"],
  ["go", "golang/go"],
  ["node", "nodejs/node"],
  ["python", "python/cpython"],
  ["rust", "rust-lang/rust"],
  ["uv", "astral-sh/uv"],
  ["gh", "cli/cli"],
  ["hk", "jdx/hk"],
  ["pkl", "apple/pkl"],
  ["usage", "jdx/usage"],
  ["pitchfork", "jdx/pitchfork"],
  ["jq", "jqlang/jq"],
  ["yq", "mikefarah/yq"],
  ["pnpm", "pnpm/pnpm"],
  ["zig", "ziglang/zig"],
  ["actionlint", "rhysd/actionlint"],
  ["shellcheck", "koalaman/shellcheck"],
  ["shfmt", "mvdan/sh"],
  ["ripgrep", "BurntSushi/ripgrep"],
  ["just", "casey/just"],
]);

/** Tools whose versions are tags rather than releases. */
const tagged = new Set(["go", "python", "node"]);

const extractMise = (file: string, text: string): Extraction => {
  const config: unknown = Bun.TOML.parse(text);
  const dependencies: Array<Dependency> = [];
  const notes: Array<string> = [];

  const tools =
    Predicate.isObject(config) &&
    "tools" in config &&
    Predicate.isObject(config.tools)
      ? config.tools
      : {};

  for (const [depName, value] of Object.entries(tools)) {
    const currentValue = Predicate.isString(value)
      ? value
      : Predicate.isObject(value) &&
          "version" in value &&
          Predicate.isString(value.version)
        ? value.version
        : undefined;

    if (currentValue === undefined) {
      notes.push(`${file}: mise pin for ${depName} isn't read`);

      continue;
    }

    const [backend = "", ...rest] = depName.split(":");
    const tool = rest.join(":");

    const repository =
      backend === "aqua" || backend === "github" || backend === "ubi"
        ? tool
        : upstreams.get(depName);

    const base = {
      manager: "mise",
      file,
      depName,
      depType: "tools",
      currentValue,
    };

    if (backend === "npm") {
      dependencies.push({ ...base, packageName: tool, datasource: "npm" });

      continue;
    }

    if (repository === undefined) {
      dependencies.push({
        ...base,
        packageName: depName,
        datasource: "unknown",
      });

      continue;
    }

    dependencies.push({
      ...base,
      packageName: repository,
      datasource: tagged.has(depName) ? "github-tags" : "github-releases",
      sourceUrl: `https://github.com/${repository}`,
      extractVersion:
        "(?:^|[^0-9])v?(?<version>[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$",
    });
  }

  return { dependencies, notes };
};

const Steps = Schema.optional(
  Schema.Array(Schema.Struct({ uses: Schema.optional(Schema.String) })),
);

/** The parts of a workflow or action that use other actions. */
const Workflow = Schema.Struct({
  jobs: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({ uses: Schema.optional(Schema.String), steps: Steps }),
    ),
  ),
  runs: Schema.optional(Schema.Struct({ steps: Steps })),
});

const decodeWorkflow = Schema.decodeUnknownOption(Workflow);

const extractActions = (file: string, text: string): Extraction => {
  const decoded = decodeWorkflow(Yaml.parse(text));

  if (Option.isNone(decoded))
    return { dependencies: [], notes: [`${file} couldn't be read`] };

  const workflow = decoded.value;
  const dependencies: Array<Dependency> = [];
  const notes: Array<string> = [];

  const references = [
    ...Object.values(workflow.jobs ?? {}).flatMap((job) => [
      job.uses,
      ...(job.steps ?? []).map((step) => step.uses),
    ]),
    ...(workflow.runs?.steps ?? []).map((step) => step.uses),
  ].filter(Predicate.isString);

  // The version comment after a pinned SHA, such as `# v4.2.0`
  const comments = new Map(
    [
      ...text.matchAll(
        /^\s*(?:-\s*)?uses:\s*["']?(?<uses>[^\s"'#]+)["']?\s*(?:#\s*(?:tag=)?(?<comment>\S+))?/gm,
      ),
    ].map((match) => [match.groups?.uses, match.groups?.comment]),
  );

  for (const reference of new Set(references)) {
    if (reference.startsWith("./") || reference.startsWith("docker://"))
      continue;

    const remote = /^(?<repo>[\w.-]+\/[\w.-]+)(?:\/[^@]+)?@(?<ref>.+)$/.exec(
      reference,
    )?.groups;

    if (remote?.repo === undefined || remote.ref === undefined) {
      notes.push(`${file}: action reference ${reference} isn't read`);

      continue;
    }

    const digest = /^[a-f\d]{40}$/i.test(remote.ref) ? remote.ref : undefined;
    const comment = comments.get(reference);

    const version =
      comment !== undefined &&
      /^v?\d+(?:\.\d+){0,2}(?:-[\w.-]+)?$/.test(comment)
        ? comment
        : undefined;

    const currentValue = digest === undefined ? remote.ref : version;

    dependencies.push({
      manager: "github-actions",
      file,
      depName: remote.repo,
      packageName: remote.repo,
      datasource:
        currentValue === undefined || !/^v?\d/.test(currentValue)
          ? "git-refs"
          : "github-tags",
      depType:
        file.endsWith("action.yml") || file.endsWith("action.yaml")
          ? "composite-action"
          : "action",
      currentValue: currentValue ?? "HEAD",
      currentDigest: digest,
      sourceUrl: `https://github.com/${remote.repo}`,
    });
  }

  return { dependencies, notes };
};

/** Fill `{{{name}}}` and `{{name}}` from the captures. */
export const render = (
  template: string,
  values: Readonly<Record<string, string>>,
) =>
  template.replace(
    /\{\{\{?\s*(?<name>\w+)\s*\}?\}\}/g,
    (_, name: string) => values[name] ?? "",
  );

type RegexManager = Extract<CustomManager, { type: "regex" }>;

/** Each match's captures, carrying the enclosing ones down for `recursive`. */
export const regexMatches = (text: string, manager: RegexManager) => {
  if (manager.strategy === "recursive") {
    let regions: Array<{ text: string; groups: Record<string, string> }> = [
      { text, groups: {} },
    ];

    for (const pattern of manager.patterns)
      regions = regions.flatMap((region) =>
        [...region.text.matchAll(new RegExp(pattern, "g"))].map((match) => ({
          text: match[0],
          groups: { ...region.groups, ...cleanGroups(match.groups) },
        })),
      );

    return regions.map((region) => region.groups);
  }

  if (manager.strategy === "combination") {
    const groups: Record<string, string> = {};

    for (const pattern of manager.patterns)
      for (const match of text.matchAll(new RegExp(pattern, "g")))
        Object.assign(groups, cleanGroups(match.groups));

    return Object.keys(groups).length === 0 ? [] : [groups];
  }

  return manager.patterns.flatMap((pattern) =>
    [...text.matchAll(new RegExp(pattern, "g"))].map((match) =>
      cleanGroups(match.groups),
    ),
  );
};

const cleanGroups = (groups: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(
    Object.entries(groups ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const extractRegex = (
  file: string,
  text: string,
  manager: RegexManager,
): Extraction => {
  const dependencies: Array<Dependency> = [];
  const notes: Array<string> = [];

  for (const groups of regexMatches(text, manager)) {
    const field = (name: keyof RegexManager["templates"]) => {
      const template = manager.templates[name];

      const value =
        template === undefined ? groups[name] : render(template, groups);

      return value === "" ? undefined : value;
    };

    const depName = field("depName");
    const currentValue = field("currentValue");
    const datasource = field("datasource");

    if (depName === undefined || datasource === undefined) {
      notes.push(`${file}: a regex match has no depName or datasource`);

      continue;
    }

    dependencies.push({
      manager: "custom.regex",
      file,
      depName,
      packageName: field("packageName") ?? depName,
      datasource,
      depType: field("depType") ?? "regex",
      currentValue: currentValue ?? "",
      currentDigest: groups.currentDigest,
      versioning: field("versioning"),
      extractVersion: field("extractVersion"),
    });
  }

  return { dependencies, notes };
};

/** Every dependency in a repository's files, by the policy's managers. */
export const extract = (
  policy: Policy,
  files: ReadonlyMap<string, string>,
): Extraction => {
  const dependencies: Array<Dependency> = [];
  const notes: Array<string> = [];

  const attempt = (file: string, run: () => Extraction) => {
    try {
      const result = run();

      dependencies.push(...result.dependencies);
      notes.push(...result.notes);
    } catch (cause) {
      notes.push(`${file} couldn't be read: ${String(cause)}`);
    }
  };

  for (const [file, text] of files) {
    if (ignored(policy, file)) continue;

    if (
      matchesFiles(file, filePatterns.npm) &&
      (enabled(policy, "npm") || enabled(policy, "bun"))
    )
      attempt(file, () => extractPackage(file, text, files));

    if (matchesFiles(file, filePatterns.mise) && enabled(policy, "mise"))
      attempt(file, () => extractMise(file, text));

    if (
      matchesFiles(file, filePatterns["github-actions"]) &&
      enabled(policy, "github-actions")
    )
      attempt(file, () => extractActions(file, text));

    for (const manager of policy.customManagers) {
      if (!matchesFiles(file, manager.files)) continue;

      if (manager.type === "jsonata") {
        if (enabled(policy, "custom.jsonata"))
          notes.push(
            `${file}: jsonata custom manager${manager.description === undefined ? "" : ` (${manager.description})`} isn't read yet`,
          );

        continue;
      }

      if (enabled(policy, "custom.regex"))
        attempt(file, () => extractRegex(file, text, manager));
    }
  }

  return { dependencies, notes: [...new Set(notes)] };
};
