/**
 * The managers: find the dependencies in a repository's files, read from
 * their text without running a package manager. npm and Bun read
 * package.json with the versions its lockfile pins, mise reads its TOML
 * configs, GitHub Actions reads workflows and actions, git submodules read
 * .gitmodules and the commits the tree pins, Dockerfiles and Compose files
 * give their images, go.mod its modules, Gradle scripts their artifacts and
 * plugins, requirements files their pins, and custom regex and jsonata
 * managers read whatever
 * files a policy points them at.
 */
import jsonata from "jsonata";
import { Cause, Effect, Match, Option, Predicate, Schema } from "effect";
import { Yaml } from "effect/encoding";
import * as Lockfiles from "./Lockfiles";
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
  "git-submodules": ["/(^|/)\\.gitmodules$/"],
  dockerfile: [
    "/(^|/|\\.)([Dd]ocker|[Cc]ontainer)file$/",
    "/(^|/)([Dd]ocker|[Cc]ontainer)file[^/]*$/",
  ],
  "docker-compose": ["/(^|/)(?:docker-)?compose[^/]*\\.ya?ml$/"],
  gomod: ["/(^|/)go\\.mod$/"],
  gradle: ["/\\.gradle(\\.kts)?$/"],
  pip_requirements: ["/(^|/)[\\w-]*requirements([-.]\\w+)?\\.(txt|pip)$/"],
};

/** What extraction found, with what it couldn't read. */
export interface Extraction {
  readonly dependencies: ReadonlyArray<Dependency>;
  readonly notes: ReadonlyArray<string>;
}

/** Whether a policy's ignorePaths leave a file out, as globs or substrings. */
export const ignored = (policy: Policy, file: string) =>
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
        Lockfiles.names.some(
          (name) => file === name || file.endsWith(`/${name}`),
        ) ||
        Object.values(filePatterns).some((patterns) =>
          matchesFiles(file, patterns),
        ) ||
        policy.customManagers.some((manager) =>
          matchesFiles(file, manager.files),
        )),
  );

const dirname = (file: string) =>
  file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";

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

/** One entry of a package.json dependency list. */
interface Entry {
  readonly depName: string;
  readonly value: Schema.Json;
  /** The keys of the object it sits in, for an override. */
  readonly parents?: ReadonlyArray<string> | undefined;
}

const isNested = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

/**
 * An overrides block's entries, as Renovate's npm extractor reads them:
 * every string value under its key, however deeply it's nested.
 */
const overrideEntries = (
  entries: Readonly<Record<string, Schema.Json>>,
  parents: ReadonlyArray<string> = ["overrides"],
): Array<Entry> =>
  Object.entries(entries).flatMap(([depName, value]) =>
    isNested(value)
      ? overrideEntries(value, [...parents, depName])
      : [{ depName, value, parents }],
  );

const extractPackage = (
  file: string,
  text: string,
  files: ReadonlyMap<string, string>,
  read: (lockfile: string) => Lockfiles.Locked | undefined,
): Extraction => {
  const decoded = decodePackageJson(JSON.parse(text));

  if (Option.isNone(decoded))
    return { dependencies: [], notes: [`${file} couldn't be read`] };

  const manifest = decoded.value;
  const lock = Lockfiles.nearest(file, files);
  const manager = lock?.split("/").at(-1) === "bun.lock" ? "bun" : "npm";
  const locked = lock === undefined ? undefined : read(lock);
  const directory = lock === undefined ? "" : Lockfiles.relative(file, lock);

  const dependencies: Array<Dependency> = [];
  const notes: Array<string> = [];

  for (const depType of dependencyTypes) {
    const entries = manifest[depType];

    if (entries === undefined) continue;

    for (const { depName, value, parents } of depType === "overrides"
      ? overrideEntries(entries)
      : Object.entries(entries).map(([name, json]): Entry => ({
          depName: name,
          value: json,
        }))) {
      if (!Predicate.isString(value)) {
        notes.push(`${file}: nested ${depType} for ${depName} aren't read`);

        continue;
      }

      // A `$name` override follows the dependency it names
      if (value.startsWith("$")) continue;

      // `"."` overrides the package it sits under, which the applier would
      // look for by that package's name rather than the `"."` key
      if (depName === ".") {
        notes.push(
          `${file}: the "." override for ${parents?.at(-1) ?? "the package"} isn't read`,
        );

        continue;
      }

      const dependency = packageDependency(
        manager,
        file,
        depName,
        value,
        depType,
      );

      // An alias moves under its own name, which the lockfile doesn't key
      const lockedVersion =
        dependency.datasource === "npm" &&
        dependency.packageName === depName &&
        Lockfiles.lockedTypes.has(depType)
          ? locked?.(directory, depType, depName, value)
          : undefined;

      dependencies.push({
        ...dependency,
        lockFiles: lock === undefined ? undefined : [lock],
        lockedVersion,
        parents,
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

/**
 * An image reference as a dependency: the name without its tag or digest,
 * the tag, and any `@sha256:` digest. A reference with a variable in it, or
 * a digest with no tag, isn't read, as there's no tag to follow.
 */
export const imageDependency = (
  manager: string,
  file: string,
  depType: string,
  image: string,
): Dependency | string => {
  if (image.includes("$")) return `${file}: image ${image} uses a variable`;

  const [named = "", digest] = image.split("@");
  const slash = named.lastIndexOf("/");
  const colon = named.lastIndexOf(":");
  const tagged = colon > slash;
  const depName = tagged ? named.slice(0, colon) : named;

  if (depName === "" || (digest !== undefined && !digest.startsWith("sha256:")))
    return `${file}: image ${image} isn't read`;

  if (!tagged && digest !== undefined)
    return `${file}: image ${image} has a digest but no tag to follow`;

  return {
    manager,
    file,
    depName,
    packageName: depName,
    datasource: "docker",
    depType,
    currentValue: tagged ? named.slice(colon + 1) : "",
    currentDigest: digest,
  };
};

/** Each extracted image or note into an extraction. */
const images = (results: ReadonlyArray<Dependency | string>): Extraction => ({
  dependencies: results.filter(
    (result): result is Dependency => !Predicate.isString(result),
  ),
  notes: results.filter(Predicate.isString),
});

/**
 * The images a Dockerfile's `FROM` lines build on, past any `--platform`
 * flag, leaving out `scratch` and earlier stages it names. The last is the
 * `final` stage, as Renovate types it.
 */
const extractDockerfile = (file: string, text: string): Extraction => {
  const stages = new Set<string>();
  const found: Array<Dependency | string> = [];

  for (const line of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const from =
      /^\s*FROM\s+(?:--\w[\w-]*=\S+\s+)*(?<image>\S+)(?:\s+AS\s+(?<stage>\S+))?/i.exec(
        line,
      )?.groups;

    if (from?.image === undefined) continue;

    if (from.image !== "scratch" && !stages.has(from.image.toLowerCase()))
      found.push(imageDependency("dockerfile", file, "stage", from.image));

    if (from.stage !== undefined) stages.add(from.stage.toLowerCase());
  }

  const last = found.findLastIndex((result) => !Predicate.isString(result));
  const final = found[last];

  if (final !== undefined && !Predicate.isString(final))
    found[last] = { ...final, depType: "final" };

  return images(found);
};

/** A Compose service or job container: an image, or settings with one. */
const Container = Schema.Union([
  Schema.String,
  Schema.Struct({ image: Schema.optional(Schema.String) }),
]);

const decodeContainer = Schema.decodeUnknownOption(Container);

/** The image a container names: the value, or its `image:`. */
const imageOf = (container: typeof Container.Type) =>
  Predicate.isString(container) ? container : container.image;

/** Containers by name, each read on its own so an odd one skips only itself. */
const Containers = Schema.Record(Schema.String, Schema.Unknown);

const decodeContainers = Schema.decodeUnknownOption(Containers);

/** The images of the containers that name one, by name. */
const containerImages = (containers: Option.Option<typeof Containers.Type>) =>
  Object.values(Option.getOrElse(containers, () => ({}))).flatMap(
    (container) => {
      const image = Option.getOrUndefined(
        Option.map(decodeContainer(container), imageOf),
      );

      return image === undefined ? [] : [image];
    },
  );

const Compose = Schema.Struct({
  services: Schema.optional(Schema.Unknown),
});

const decodeCompose = Schema.decodeUnknownOption(Compose);

/** The `image:` of each service in a Compose file. */
const extractCompose = (file: string, text: string): Extraction => {
  const decoded = decodeCompose(Yaml.parse(text));

  if (Option.isNone(decoded))
    return { dependencies: [], notes: [`${file} couldn't be read`] };

  return images(
    containerImages(decodeContainers(decoded.value.services)).map((image) =>
      imageDependency("docker-compose", file, "image", image),
    ),
  );
};

const Steps = Schema.optional(
  Schema.Array(Schema.Struct({ uses: Schema.optional(Schema.String) })),
);

/** The parts of a workflow or action that use other actions and images. */
const Workflow = Schema.Struct({
  jobs: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        uses: Schema.optional(Schema.String),
        steps: Steps,
        container: Schema.optional(Schema.Unknown),
        services: Schema.optional(Schema.Unknown),
      }),
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
  const jobs = Object.values(workflow.jobs ?? {});
  const dependencies: Array<Dependency> = [];
  const notes: Array<string> = [];

  const references = [
    ...jobs.flatMap((job) => [
      job.uses,
      ...(job.steps ?? []).map((step) => step.uses),
    ]),
    ...(workflow.runs?.steps ?? []).map((step) => step.uses),
  ].filter(Predicate.isString);

  // Job containers and services, and `docker://` steps, are images
  const containers = images(
    [
      ...jobs.flatMap((job) => [
        ...containerImages(decodeContainers({ container: job.container })).map(
          (image) => ({ image, depType: "container" }),
        ),
        ...containerImages(decodeContainers(job.services)).map((image) => ({
          image,
          depType: "service",
        })),
      ]),
      ...references.flatMap((reference) =>
        reference.startsWith("docker://")
          ? [{ image: reference.slice("docker://".length), depType: "docker" }]
          : [],
      ),
    ].map(({ image, depType }) =>
      imageDependency("github-actions", file, depType, image),
    ),
  );

  dependencies.push(...containers.dependencies);
  notes.push(...containers.notes);

  // The version comment after a pinned SHA, such as `# v4.2.0`
  const comments = new Map(
    [
      ...text.matchAll(
        /^\s*(?:-\s*)?uses:\s*["']?(?<uses>[^\s"'#]+)["']?\s*(?:#\s*(?:tag=)?(?<comment>\S+))?/gm,
      ),
    ].map((match) => [match.groups?.uses, match.groups?.comment]),
  );

  for (const reference of new Set(references)) {
    // `./` and GitHub's `$/` point into this repository at the running commit
    if (
      reference.startsWith("./") ||
      reference.startsWith("$/") ||
      reference.startsWith("docker://")
    )
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

/** Each submodule in a `.gitmodules` file, with its settings by key. */
export const parseGitmodules = (text: string) => {
  const submodules: Array<Record<string, string>> = [];
  let current: Record<string, string> | undefined;

  for (const raw of text.split("\n")) {
    const line = raw.trim();

    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;

    if (line.startsWith("[")) {
      current = /^\[submodule\s+"[^"]*"\]$/.test(line) ? {} : undefined;

      if (current !== undefined) submodules.push(current);

      continue;
    }

    const setting = /^(?<key>[\w.-]+)\s*=\s*(?<value>.*)$/.exec(line)?.groups;

    if (current !== undefined && setting?.key !== undefined)
      current[setting.key.toLowerCase()] = (setting.value ?? "").replace(
        /^"(?<inner>.*)"$/,
        "$<inner>",
      );
  }

  return submodules;
};

/**
 * Submodules, as Renovate reads them: each one follows the branch its
 * `.gitmodules` entry names, or the remote's default branch, and an update
 * moves the commit it's pinned to. The commit comes from the gitlinks, the
 * submodule commits the repository's tree records.
 */
const extractSubmodules = (
  file: string,
  text: string,
  gitlinks: ReadonlyMap<string, string>,
): Extraction => {
  const dependencies: Array<Dependency> = [];
  const notes: Array<string> = [];
  const directory = dirname(file);

  for (const submodule of parseGitmodules(text)) {
    const { path: relative, url, branch } = submodule;

    if (relative === undefined || url === undefined) continue;

    const path = directory === "" ? relative : `${directory}/${relative}`;
    const digest = gitlinks.get(path);

    if (digest === undefined) {
      notes.push(`${file}: submodule ${path} has no commit in the tree`);

      continue;
    }

    if (url.startsWith(".") || branch === ".") {
      notes.push(
        `${file}: submodule ${path} has a relative URL or branch, which isn't read`,
      );

      continue;
    }

    dependencies.push({
      manager: "git-submodules",
      file,
      depName: path,
      packageName: url,
      datasource: "git-refs",
      depType: "submodule",
      currentValue: branch ?? "HEAD",
      currentDigest: digest,
    });
  }

  return { dependencies, notes };
};

/** A Go pseudo-version, a commit rather than a release. */
export const goPseudo = /\d{14}-[\da-f]{12}(?:\+incompatible)?$/;

/**
 * A go.mod's requirements, as Renovate's gomod manager reads them: each
 * direct `require`, leaving out indirect ones, pseudo-versions and modules a
 * `replace` points elsewhere, plus the `toolchain`, which follows Go's tags.
 */
export const extractGoMod = (file: string, text: string): Extraction => {
  const dependencies: Array<Dependency> = [];
  const replaced = new Set<string>();
  const required: Array<{ module: string; version: string }> = [];
  let block: "require" | "replace" | undefined;

  for (const raw of text.split("\n")) {
    const line = raw.trim();

    if (block !== undefined && line === ")") {
      block = undefined;
      continue;
    }

    const opens = /^(require|replace)\s*\($/.exec(line)?.[1];

    if (opens === "require" || opens === "replace") {
      block = opens;
      continue;
    }

    const replace =
      block === "replace" ? line : /^replace\s+(.+)$/.exec(line)?.[1];

    if (replace !== undefined) {
      const module = replace.split(/\s+/)[0];

      if (module !== undefined && module !== "") replaced.add(module);

      continue;
    }

    const requirement =
      block === "require" ? line : /^require\s+(.+)$/.exec(line)?.[1];

    if (requirement !== undefined) {
      if (/\/\/\s*indirect\b/.test(requirement)) continue;

      const [module, version] = requirement.split(/\s+/);

      if (
        module !== undefined &&
        version?.startsWith("v") === true &&
        !goPseudo.test(version)
      )
        required.push({ module, version });

      continue;
    }

    const toolchain = /^toolchain\s+go(\S+)$/.exec(line)?.[1];

    if (toolchain !== undefined)
      dependencies.push({
        manager: "gomod",
        file,
        depName: "go",
        packageName: "golang/go",
        datasource: "github-tags",
        depType: "toolchain",
        currentValue: toolchain,
        extractVersion: "^go(?<version>\\d+\\.\\d+\\.\\d+)$",
      });
  }

  for (const { module, version } of required) {
    if (replaced.has(module)) continue;

    dependencies.push({
      manager: "gomod",
      file,
      depName: module,
      packageName: module,
      datasource: "go",
      depType: "require",
      currentValue: version,
    });
  }

  return { dependencies, notes: [] };
};

/**
 * A requirements file's exact pins, `name==version`, as Renovate's
 * pip_requirements manager updates them. Ranges, options and includes are
 * left alone.
 */
export const extractRequirements = (file: string, text: string): Extraction => {
  const dependencies: Array<Dependency> = [];

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();

    const pin =
      /^(?<name>[A-Za-z\d][\w.-]*)(?:\[[^\]]*\])?\s*==\s*(?<version>[^\s;,]+)\s*(?:;.*)?$/.exec(
        line,
      )?.groups;

    if (pin?.name === undefined || pin.version === undefined) continue;

    dependencies.push({
      manager: "pip_requirements",
      file,
      depName: pin.name,
      packageName: pin.name,
      datasource: "pypi",
      depType: "requirements",
      currentValue: pin.version,
      versioning: "pep440",
    });
  }

  return { dependencies, notes: [] };
};

/**
 * A Gradle build script's dependencies, `"group:artifact:version"`, and its
 * plugins, `id("name") version "1.2.3"`, as Renovate's gradle manager reads
 * them. A version made from a variable, a range or a dynamic `+` is left
 * out, and a dependency written twice in one file is read once.
 */
export const extractGradle = (file: string, text: string): Extraction => {
  const dependencies = new Map<string, Dependency>();
  const literal = /^\d[\w.-]*$/;

  for (const match of text.matchAll(
    /(["'])(?<group>[\w.-]+):(?<artifact>[\w.-]+):(?<version>[^"'\s:@]+)(?::[\w.-]+)?(?:@\w+)?\1/g,
  )) {
    const { group, artifact, version } = match.groups ?? {};

    if (
      group === undefined ||
      artifact === undefined ||
      version === undefined ||
      !literal.test(version)
    )
      continue;

    const name = `${group}:${artifact}`;

    dependencies.set(`${name}@${version}`, {
      manager: "gradle",
      file,
      depName: name,
      packageName: name,
      datasource: "maven",
      depType: "dependencies",
      currentValue: version,
    });
  }

  for (const match of text.matchAll(
    /\bid\s*\(?\s*(["'])(?<id>[\w.-]+)\1\s*\)?\s+version\s*\(?\s*(["'])(?<version>[^"'\s]+)\3/g,
  )) {
    const { id, version } = match.groups ?? {};

    if (id === undefined || version === undefined || !literal.test(version))
      continue;

    dependencies.set(`plugin:${id}@${version}`, {
      manager: "gradle",
      file,
      depName: id,
      packageName: id,
      datasource: "gradle-plugin",
      depType: "plugin",
      currentValue: version,
    });
  }

  return { dependencies: [...dependencies.values()], notes: [] };
};

/** A Handlebars string literal, in single or double quotes. */
const literal = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"`;

/** `{{name}}`, or Renovate's `{{replace 'find' 'with' name}}` helper. */
const placeholder = new RegExp(
  String.raw`\{\{\{?\s*(?:replace\s+(?<find>${literal})\s+(?<with>${literal})\s+(?<field>\w+)|(?<name>\w+))\s*\}?\}\}`,
  "g",
);

/** A literal's text, with only its own quote unescaped, as Handlebars has it. */
const unquote = (quoted: string) =>
  quoted.slice(1, -1).replaceAll(`\\${quoted[0]}`, quoted[0] ?? "");

/**
 * Fill `{{{name}}}` and `{{name}}` from the captures, and Renovate's
 * `replace` helper, which replaces every match of a regex in a field. A
 * regex that doesn't compile leaves the field as it is.
 */
export const render = (
  template: string,
  values: Readonly<Record<string, string>>,
) =>
  template.replace(
    placeholder,
    (
      _,
      find: string | undefined,
      replacement: string | undefined,
      field: string | undefined,
      name: string | undefined,
    ) => {
      if (name !== undefined) return values[name] ?? "";

      const value = values[field ?? ""] ?? "";

      try {
        return value.replace(
          new RegExp(unquote(find ?? "''"), "g"),
          unquote(replacement ?? "''"),
        );
      } catch {
        return value;
      }
    },
  );

/**
 * A dependency's fields under the names Renovate's templates give them, for
 * templates such as replacementNameTemplate that render against it.
 */
export const dependencyValues = (dependency: Dependency) =>
  Object.fromEntries(
    Object.entries({
      manager: dependency.manager,
      packageFile: dependency.file,
      depName: dependency.depName,
      packageName: dependency.packageName,
      datasource: dependency.datasource,
      depType: dependency.depType,
      currentValue: dependency.currentValue,
      currentVersion: dependency.lockedVersion,
      currentDigest: dependency.currentDigest,
      sourceUrl: dependency.sourceUrl,
      versioning: dependency.versioning,
    }).filter((entry): entry is [string, string] =>
      Predicate.isString(entry[1]),
    ),
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
  /** Each submodule's path and the commit the tree pins it to. */
  gitlinks: ReadonlyMap<string, string> = new Map(),
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

  // Each lockfile read once, however many package.json files it pins
  const lockfiles = new Map<string, Lockfiles.Locked | undefined>();

  const readLockfile = (lockfile: string) => {
    if (!lockfiles.has(lockfile)) {
      try {
        lockfiles.set(
          lockfile,
          Lockfiles.read(lockfile, files.get(lockfile) ?? ""),
        );
      } catch (cause) {
        lockfiles.set(lockfile, undefined);
        notes.push(
          `${lockfile} couldn't be read, so its locked versions aren't known: ${String(cause)}`,
        );
      }
    }

    return lockfiles.get(lockfile);
  };

  for (const [file, text] of files) {
    if (ignored(policy, file)) continue;

    if (
      matchesFiles(file, filePatterns.npm) &&
      (enabled(policy, "npm") || enabled(policy, "bun"))
    )
      attempt(file, () => extractPackage(file, text, files, readLockfile));

    if (matchesFiles(file, filePatterns.mise) && enabled(policy, "mise"))
      attempt(file, () => extractMise(file, text));

    if (
      matchesFiles(file, filePatterns["github-actions"]) &&
      enabled(policy, "github-actions")
    )
      attempt(file, () => extractActions(file, text));

    if (
      matchesFiles(file, filePatterns["git-submodules"]) &&
      enabled(policy, "git-submodules")
    )
      attempt(file, () => extractSubmodules(file, text, gitlinks));

    if (
      matchesFiles(file, filePatterns.dockerfile) &&
      enabled(policy, "dockerfile")
    )
      attempt(file, () => extractDockerfile(file, text));

    if (
      matchesFiles(file, filePatterns["docker-compose"]) &&
      enabled(policy, "docker-compose")
    )
      attempt(file, () => extractCompose(file, text));

    if (matchesFiles(file, filePatterns.gomod) && enabled(policy, "gomod"))
      attempt(file, () => extractGoMod(file, text));

    if (matchesFiles(file, filePatterns.gradle) && enabled(policy, "gradle"))
      attempt(file, () => extractGradle(file, text));

    if (
      matchesFiles(file, filePatterns.pip_requirements) &&
      enabled(policy, "pip_requirements")
    )
      attempt(file, () => extractRequirements(file, text));

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
