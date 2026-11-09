/**
 * What counts as shipped: the policies that give each change since a
 * repository's last stable release its impact, from nothing for docs and
 * tooling to a patch for shipped content, before your choices on the page.
 * Ported from `dot git releases` with the same rules, so its hashes and the
 * choices made on them carry over.
 */
import type { Domain } from "@upkeep/api";
import { evidenceId, highestImpact } from "@upkeep/api/releases";
import type { ReleaseRepo, ReleaseRule } from "../settings";

/** Bump when a policy classifies differently, so old comparisons go stale. */
export const policyVersion = 13;

export type Policy = NonNullable<ReleaseRepo["policy"]>;

/** A fact before its policy is applied: everything but the impact. */
export type Fact = Domain.ReleaseFact;

const quietPaths = [
  "**/docs",
  "**/docs/**",
  "**/doc",
  "**/doc/**",
  "**/documentation",
  "**/documentation/**",
  "**/*.md",
  "**/*.mdx",
  "**/*.rst",
  "**/[Rr][Ee][Aa][Dd][Mm][Ee]*",
  "**/mise.toml",
  "**/mise.*.toml",
  "**/.mise.toml",
  "**/.mise.*.toml",
  "**/mise.lock",
  "**/.mise.lock",
  "**/.config/mise/**",
  "**/.agents/**",
  "**/skills-lock.json",
  "**/.opencode/**",
  "**/.cursor/**",
  "**/.vscode/**",
  "**/.scripts/**",
  "**/.github/**",
  "**/tsconfig*.json",
  "**/oxlint.config.*",
  "**/.oxlint*",
  "**/.prettier*",
  "**/.yamllint*",
  "**/.markdownlint*",
  "**/eslint.config.*",
  "**/.eslintrc*",
  "**/.editorconfig",
  "**/.gitignore",
  "**/mlc_config.json",
  "**/pitchfork.toml",
  "**/PKGBUILD",
];

const quiet: ReleaseRule = {
  paths: quietPaths,
  impact: "none",
  reason: "Documentation and development tooling are quiet",
};

const omarchyPluginPaths = ["**/omarchy-plugin", "**/omarchy-plugin/**"];

const omarchyPlugin: ReleaseRule = {
  paths: omarchyPluginPaths,
  impact: "none",
  reason: "Omarchy plugin is published separately and pinned by commit",
};

/** Build dependencies whose output System Bridge ships. */
export const systemBridgeBuildDependencies: ReadonlyArray<string> = [
  "vite",
  "@tailwindcss/vite",
  "tailwindcss",
  "@tailwindcss/node",
  "@tailwindcss/oxide",
  "postcss",
];

const glob = (pattern: string, path: string) =>
  new Bun.Glob(pattern).match(path);

/**
 * Whether a path is tooling or a product published on its own, which counts
 * as a file change but isn't read for dependencies.
 */
export const separatelyPublished = (path: string, policy: Policy) =>
  [...quietPaths, ...omarchyPluginPaths].some((pattern) =>
    glob(pattern, path),
  ) ||
  (policy === "system-bridge" && (path === "docs" || path.startsWith("docs/")));

const tests: ReleaseRule = {
  paths: [
    "**/*.test.*",
    "**/*.spec.*",
    "**/*_test.go",
    "**/test/**",
    "**/tests/**",
    "**/__tests__/**",
    "**/testdata/**",
  ],
  impact: "none",
  reason: "Tests are not shipped",
};

const dependencies: ReadonlyArray<ReleaseRule> = [
  {
    roles: ["runtime", "build"],
    impact: "none",
    reason: "Dependency updates are quiet",
  },
  {
    roles: ["peer"],
    impact: "none",
    reason: "Peer requirement updates are quiet",
  },
  {
    roles: ["development"],
    impact: "none",
    reason: "Development-only dependency changed",
  },
];

const presets: Record<Policy, ReadonlyArray<ReleaseRule>> = {
  application: [
    quiet,
    omarchyPlugin,
    tests,
    ...dependencies,
    {
      paths: [
        "**/test_*.py",
        "**/*_test.py",
        "**/docs/**",
        "**/AGENTS.md",
        "**/CLAUDE.md",
        "**/README*",
        "**/CHANGELOG*",
        ".agents/**",
        ".cursor/**",
        ".vscode/**",
        ".github/workflows/**",
        ".github/ISSUE_TEMPLATE/**",
        ".github/PULL_REQUEST_TEMPLATE*",
        "**/eslint*",
        "**/.prettier*",
        "**/.oxlint*",
        "**/.golangci*",
        "**/.markdownlint*",
        "**/.yamllint*",
        "**/ruff.toml",
        "**/.ruff.toml",
        "**/pytest.ini",
        "**/renovate.json*",
        "**/opencode.json*",
        "pitchfork.toml",
      ],
      impact: "none",
      reason:
        "Tests, documentation, agent configuration or lint/CI-only change",
    },
    {
      impact: "patch",
      reason:
        "Shipped application content, build or package definition changed",
    },
  ],
  "oxlint-rules": [
    quiet,
    omarchyPlugin,
    tests,
    ...dependencies,
    {
      paths: ["vendor/anti-slop/src/**", "vendor/anti-slop/LICENSE"],
      impact: "patch",
      reason: "Upstream shipped rule content changed",
    },
    {
      submodules: ["vendor/anti-slop"],
      impact: "none",
      reason:
        "Upstream change outside shipped content; inspect the pin and upstream findings",
    },
    {
      paths: [
        ".github/**",
        ".agents/**",
        "tests/**",
        "tsconfig.json",
        "renovate.json",
        ".prettier*",
        ".oxlint*",
        "scripts/test.ts",
      ],
      impact: "none",
      reason: "Development tooling or CI-only change",
    },
    {
      paths: [
        "src/**",
        "dist/**",
        "skills/**",
        "scripts/build.ts",
        "README.md",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        "package.json",
      ],
      impact: "patch",
      reason: "Shipped package content or build definition changed",
    },
  ],
  "system-bridge": [
    quiet,
    omarchyPlugin,
    {
      paths: ["docs/**"],
      impact: "none",
      reason: "Separately deployed docs",
    },
    tests,
    {
      dependencies: [
        "github.com/stretchr/testify",
        "github.com/davecgh/go-spew",
        "github.com/pmezard/go-difflib",
      ],
      impact: "none",
      reason: "Go test support dependency changed",
    },
    ...dependencies,
    {
      paths: [".resources/**"],
      impact: "patch",
      reason: "Shipped package content changed",
    },
    {
      paths: [
        ".github/**",
        ".agents/**",
        ".cursor/**",
        ".vscode/**",
        "docs/**",
        "**/eslint*",
        "**/.prettier*",
        "**/tsconfig*",
        ".golangci.yml",
        ".markdownlint*",
        ".yamllint*",
        "renovate.json",
        "opencode.json",
        "pitchfork.toml",
        "README.md",
        "AGENTS.md",
        "CLAUDE.md",
        "package.json",
        "mise.lock",
        "build/**",
        "Dockerfile*",
        "go.mod",
        "go.sum",
      ],
      impact: "none",
      reason: "Documentation, dependency, build tooling or CI-only change",
    },
    {
      paths: ["connector/**"],
      impact: "patch",
      reason: "Published Effect connector changed",
    },
    {
      paths: ["**/*.go", "web-client/**", "tui/**", "mise.toml", "LICENSE"],
      impact: "patch",
      reason:
        "Shipped application, embedded client, TUI or package content changed",
    },
  ],
};

/**
 * Whether a rule matches a change. Commit subjects only count when a rule
 * names them, never from ordinary commit prose.
 */
export const matches = (rule: ReleaseRule, fact: Fact) =>
  (rule.paths === undefined ||
    rule.paths.some(
      (pattern) =>
        glob(pattern, fact.path) ||
        (fact.previousPath !== null && glob(pattern, fact.previousPath)),
    )) &&
  (rule.changeTypes === undefined ||
    rule.changeTypes.includes(fact.changeType)) &&
  (rule.dependencies === undefined ||
    (fact.dependency !== null &&
      rule.dependencies.includes(fact.dependency))) &&
  (rule.roles === undefined ||
    (fact.role !== null && rule.roles.includes(fact.role))) &&
  (rule.submodules === undefined ||
    (fact.submodule !== null && rule.submodules.includes(fact.submodule))) &&
  (rule.subjects === undefined ||
    rule.subjects.some((pattern) =>
      (fact.subjects ?? (fact.subject === null ? [] : [fact.subject])).some(
        (subject) => new RegExp(pattern).test(subject),
      ),
    ));

/** A repository's settings with every default filled in. */
export interface Settings {
  readonly policy: Policy;
  readonly versioning: Domain.Versioning;
  readonly fork: Domain.ReleaseScan["fork"];
  readonly sourceMinorThreshold: number | undefined;
  readonly sourceExcludes: ReadonlyArray<string>;
  readonly overrides: ReadonlyArray<ReleaseRule>;
}

/** The defaults for what a repository's settings leave out. */
export const settingsOf = (repo: ReleaseRepo | undefined): Settings => ({
  policy: repo?.policy ?? "application",
  versioning: repo?.versioning ?? "semver",
  fork: repo?.fork ?? null,
  sourceMinorThreshold: repo?.sourceMinorThreshold,
  sourceExcludes: repo?.sourceExcludes ?? [],
  overrides: repo?.overrides ?? [],
});

/**
 * The identity of a repository's policy and settings, which a comparison
 * records, so one made under others shows as stale.
 */
export const policyId = (settings: Settings) =>
  evidenceId([
    policyVersion,
    settings.policy,
    settings.overrides.map((rule) => {
      // The key keeps dot's name, so the hashes carry over
      const { changeTypes, ...rest } = rule;

      return changeTypes === undefined
        ? rest
        : { ...rest, change_types: changeTypes };
    }),
    settings.sourceExcludes,
    settings.sourceMinorThreshold ?? null,
    settings.versioning,
    ...(settings.fork === null ? [] : [settings.fork]),
  ]);

/**
 * Give every change its impact: the first override that matches, or else
 * the policy's first rule, taking the higher of a renamed file's two paths.
 * A checksum or a submodule pin is quiet on its own; its upstream changes
 * carry the impact. Quiet and incomplete changes are kept for the page.
 * Over the size threshold, shipped source changes suggest a minor release.
 */
export const classify = (
  facts: ReadonlyArray<Fact>,
  settings: Settings,
): Array<Domain.ReleaseFinding> => {
  const findings = facts.map((fact): Domain.ReleaseFinding => {
    const override = settings.overrides.find((rule) => matches(rule, fact));

    const endpoints = [
      fact.path,
      ...(fact.previousPath === null ? [] : [fact.previousPath]),
    ].map((path) => {
      const match = presets[settings.policy].find((rule) =>
        matches(rule, { ...fact, path, previousPath: null }),
      );

      return {
        impact: match?.impact ?? "patch",
        reason: match?.reason ?? "Policy default: patch; review this change",
      };
    });

    const affected = highestImpact(endpoints.map(({ impact }) => impact));
    const match = endpoints.find(({ impact }) => impact === affected);
    const quietEvidence = fact.kind === "checksum" || fact.kind === "submodule";
    const impact = override?.impact ?? (quietEvidence ? "none" : affected);

    return {
      ...fact,
      automaticImpact: impact,
      impact,
      reason:
        override?.reason ??
        (quietEvidence
          ? fact.kind === "checksum"
            ? "Checksum or lock metadata only; package resolution unchanged"
            : "Pin changed; upstream net findings determine impact"
          : (match?.reason ?? "Policy default: patch; review this change")),
      reviewed: false,
    };
  });

  const threshold = settings.sourceMinorThreshold;

  if (threshold === undefined) return findings;

  const source = new Set(
    findings.filter(
      (finding) =>
        finding.kind === "file" &&
        finding.complete &&
        finding.automaticImpact !== "none" &&
        !/(^|\/)(package\.json|bun\.lockb?|go\.mod|go\.sum)$/.test(
          finding.path,
        ) &&
        !settings.overrides.some((rule) => matches(rule, finding)) &&
        [finding.path, finding.previousPath].some(
          (path) =>
            path !== null &&
            !settings.sourceExcludes.some((pattern) => glob(pattern, path)),
        ),
    ),
  );

  const changedLines = [...source].reduce(
    (total, finding) => total + (finding.changedLines ?? 0),
    0,
  );

  if (changedLines <= threshold) return findings;

  return findings.map((finding) =>
    source.has(finding) && (finding.changedLines ?? 0) > 0
      ? {
          ...finding,
          automaticImpact: "minor",
          impact: "minor",
          reason: `Source size heuristic: ${changedLines} added/deleted lines across non-excluded shipped source (over ${threshold})`,
        }
      : finding,
  );
};
