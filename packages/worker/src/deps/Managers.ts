/**
 * The managers: find the dependencies in a repository's files, read from
 * their text without running a package manager. npm and Bun read
 * package.json beside a bun.lock, mise reads its TOML configs, GitHub
 * Actions reads workflows and actions, and custom regex and jsonata managers
 * read whatever files a policy points them at.
 */
import jsonata from "jsonata";
import { Cause, Effect, Match, Option, Predicate, Schema } from "effect";
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

      // Renovate's bun manager doesn't read versions from bun.lock, so a
      // range in bun's hands has no locked version, and no in-range branch
      dependencies.push({
        ...dependency,
        lockFiles: lock === undefined ? undefined : [lock],
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
  ["zls", "zigtools/zls"],
  ["actionlint", "rhysd/actionlint"],
  ["shellcheck", "koalaman/shellcheck"],
  ["shfmt", "mvdan/sh"],
  ["ripgrep", "BurntSushi/ripgrep"],
  ["just", "casey/just"],
  ["yamllint", "adrienverge/yamllint"],
  ["bat", "sharkdp/bat"],
  ["eza", "eza-community/eza"],
  ["fd", "sharkdp/fd"],
  ["fzf", "junegunn/fzf"],
  ["gdu", "dundee/gdu"],
  ["gum", "charmbracelet/gum"],
  ["lazygit", "jesseduffield/lazygit"],
  ["starship", "starship/starship"],
  ["watchexec", "watchexec/watchexec"],
  ["zoxide", "ajeetdsouza/zoxide"],
  ["yarn", "yarnpkg/berry"],
  ["ollama", "ollama/ollama"],
  ["claude", "anthropics/claude-code"],
  ["copilot", "github/copilot-cli"],
  ["ghui", "kitlangton/ghui"],
  ["playwright", "microsoft/playwright"],
  ["aube", "aubepkg/aube"],
  ["golangci-lint", "golangci/golangci-lint"],
]);

/** Tools whose versions are tags rather than releases. */
const tagged = new Set(["go", "python", "node", "yamllint"]);

/** An `http:` tool downloaded from a GitHub tag's source archive. */
const tagArchive =
  /^https:\/\/github\.com\/(?<repository>[\w.-]+\/[\w.-]+)\/archive\/refs\/tags\/v?\{\{ ?version ?\}\}\.(?:tar\.gz|zip)$/;

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

    // `latest`, `lts`, `system`, `ref:` and the like follow on their own
    if (!/^v?\d/.test(currentValue)) continue;

    const [backend = "", ...rest] = depName.split(":");
    const tool = rest.join(":");

    const url =
      Predicate.isObject(value) &&
      "url" in value &&
      Predicate.isString(value.url)
        ? value.url
        : undefined;

    const archive =
      backend === "http" && url !== undefined
        ? tagArchive.exec(url)?.groups?.repository
        : undefined;

    const repository =
      backend === "aqua" || backend === "github" || backend === "ubi"
        ? tool
        : (archive ?? upstreams.get(depName));

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

    if (backend === "pipx" || backend === "pypi") {
      dependencies.push({ ...base, packageName: tool, datasource: "pypi" });

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
      datasource:
        archive !== undefined || tagged.has(depName)
          ? "github-tags"
          : "github-releases",
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

    // A digest needs a comment naming its version or branch; Renovate leaves
    // a bare one alone
    if (digest !== undefined && comment === undefined) continue;

    const currentValue = digest === undefined ? remote.ref : comment;

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

interface RegexMatch {
  readonly groups: Record<string, string>;
  /** The innermost matched text; none for `combination`, as in Renovate. */
  readonly text?: string | undefined;
}

/** Each match's captures, carrying the enclosing ones down for `recursive`. */
export const regexMatches = (
  text: string,
  manager: RegexManager,
): Array<RegexMatch> => {
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

    return regions;
  }

  if (manager.strategy === "combination") {
    const groups: Record<string, string> = {};

    for (const pattern of manager.patterns)
      for (const match of text.matchAll(new RegExp(pattern, "g")))
        Object.assign(groups, cleanGroups(match.groups));

    return Object.keys(groups).length === 0 ? [] : [{ groups }];
  }

  return manager.patterns.flatMap((pattern) =>
    [...text.matchAll(new RegExp(pattern, "g"))].map((match) => ({
      groups: cleanGroups(match.groups),
      text: match[0],
    })),
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

  for (const { groups, text: replaceString } of regexMatches(text, manager)) {
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
      replaceString,
    });
  }

  return { dependencies, notes };
};

type JsonataManager = Extract<CustomManager, { type: "jsonata" }>;

const formats = new Set(["json", "yaml", "toml"]);

/** The fields a jsonata result fills in, the same as a manager's templates. */
const JsonataResult = Schema.Struct({
  depName: Schema.optional(Schema.String),
  packageName: Schema.optional(Schema.String),
  datasource: Schema.optional(Schema.String),
  depType: Schema.optional(Schema.String),
  currentValue: Schema.optional(Schema.String),
  currentDigest: Schema.optional(Schema.String),
  versioning: Schema.optional(Schema.String),
  extractVersion: Schema.optional(Schema.String),
});

const decodeJsonataResults = Schema.decodeUnknownOption(
  Schema.Union([Schema.Undefined, JsonataResult, Schema.Array(JsonataResult)]),
);

/**
 * Each query's results, as Renovate reads them: an object or a list of
 * objects whose fields the templates then fill in or override.
 */
const extractJsonata = Effect.fnUntraced(function* (
  file: string,
  text: string,
  manager: JsonataManager,
) {
  const dependencies: Array<Dependency> = [];
  const notes: Array<string> = [];

  if (!formats.has(manager.format))
    return {
      dependencies,
      notes: [`${file}: jsonata can't read the ${manager.format} format`],
    } satisfies Extraction;

  const data = yield* Effect.try(() =>
    Match.value(manager.format).pipe(
      Match.when("yaml", () => Yaml.parse(text)),
      Match.when("toml", () => Bun.TOML.parse(text)),
      Match.orElse(() => JSON.parse(text)),
    ),
  );

  for (const query of manager.patterns) {
    const result = decodeJsonataResults(
      yield* Effect.tryPromise(() => jsonata(query).evaluate(data)),
    );

    if (Option.isNone(result)) {
      notes.push(`${file}: a jsonata query gave something other than results`);

      continue;
    }

    for (const item of result.value === undefined
      ? []
      : Array.isArray(result.value)
        ? result.value
        : [result.value]) {
      const values = Object.fromEntries(
        Object.entries(item).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );

      const field = (name: keyof JsonataManager["templates"]) => {
        const template = manager.templates[name];

        const value =
          template === undefined ? values[name] : render(template, values);

        return value === "" ? undefined : value;
      };

      const depName = field("depName");
      const datasource = field("datasource");

      if (depName === undefined || datasource === undefined) {
        notes.push(`${file}: a jsonata result has no depName or datasource`);

        continue;
      }

      dependencies.push({
        manager: "custom.jsonata",
        file,
        depName,
        packageName: field("packageName") ?? depName,
        datasource,
        depType: field("depType") ?? "jsonata",
        currentValue: field("currentValue") ?? "",
        currentDigest: values.currentDigest,
        versioning: field("versioning"),
        extractVersion: field("extractVersion"),
      });
    }
  }

  return { dependencies, notes } satisfies Extraction;
});

/** Every dependency in a repository's files, by the policy's managers. */
export const extract = Effect.fnUntraced(function* (
  policy: Policy,
  files: ReadonlyMap<string, string>,
) {
  const dependencies: Array<Dependency> = [];
  const notes: Array<string> = [];

  const add = (result: Extraction) => {
    dependencies.push(...result.dependencies);
    notes.push(...result.notes);
  };

  const unread = (file: string, cause: unknown) =>
    notes.push(`${file} couldn't be read: ${String(cause)}`);

  const attempt = (file: string, run: () => Extraction) => {
    try {
      add(run());
    } catch (cause) {
      unread(file, cause);
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
          yield* extractJsonata(file, text, manager).pipe(
            Effect.match({
              onSuccess: add,
              onFailure: (error) =>
                unread(
                  file,
                  error instanceof Cause.UnknownError ? error.cause : error,
                ),
            }),
          );

        continue;
      }

      if (enabled(policy, "custom.regex"))
        attempt(file, () => extractRegex(file, text, manager));
    }
  }

  return { dependencies, notes: [...new Set(notes)] } satisfies Extraction;
});
