/**
 * Release review and numbering: hashes that match `dot git releases`, so
 * choices carried over from it apply, the next tag for each scheme, and a new
 * comparison keeping or dropping your choices.
 */
import { expect, test } from "bun:test";
import { Result } from "effect";
import type { ReleaseFinding, ReleaseSnapshot } from "./Domain";
import {
  accept,
  applyReview,
  evidenceId,
  nextTag,
  noDecisions,
} from "./Releases";

const finding = (
  id: string,
  impact: ReleaseFinding["impact"],
): ReleaseFinding => ({
  id,
  kind: "file",
  path: `src/${id}.ts`,
  previousPath: null,
  changeType: "modified",
  before: null,
  after: null,
  dependency: null,
  role: null,
  submodule: null,
  subject: null,
  detail: `M src/${id}.ts`,
  complete: true,
  automaticImpact: impact,
  impact,
  reason: "Shipped",
  reviewed: false,
});

const snapshot = (
  findings: ReadonlyArray<ReleaseFinding>,
  overrides: Partial<ReleaseSnapshot> = {},
): ReleaseSnapshot => ({
  id: "",
  repo: "timmo001/app",
  name: "app",
  branch: "main",
  releaseTag: "1.2.3",
  releaseCommit: "base",
  head: "head",
  checkedAt: 0,
  policyId: "policy",
  comparisonId: "",
  url: "",
  commits: [],
  findings,
  files: [],
  automaticSuggestion: "patch",
  suggestion: "none",
  reviewed: false,
  complete: true,
  errors: [],
  ...overrides,
});

const tag = (
  shown: ReleaseSnapshot,
  versioning: Parameters<typeof nextTag>[1],
  now = Date.UTC(2026, 10, 9),
) => {
  const result = nextTag(
    applyReview(shown, noDecisions),
    versioning,
    { upstream: "up/stream", suffix: "me" },
    now,
  );

  return Result.isSuccess(result) ? result.success : `error: ${result.failure}`;
};

test("evidence hashes match the ones dot made", () => {
  expect(evidenceId(["a", 1, null, { b: [true, "c"], a: 2 }])).toBe(
    "94058ea9d563fbbca1693e0f560b23171e1047e88e1886e52a0144eda9f94cdc",
  );
});

test("SemVer moves by the suggested impact", () => {
  expect(tag(snapshot([finding("a", "patch")]), "semver")).toBe("1.2.4");
  expect(tag(snapshot([finding("a", "minor")]), "semver")).toBe("1.3.0");
  expect(
    tag(snapshot([finding("a", "major")], { releaseTag: "v1.2.3" }), "semver"),
  ).toBe("v2.0.0");
  expect(
    tag(snapshot([finding("a", "patch")], { releaseTag: null }), "semver"),
  ).toBe("0.1.0");
  expect(tag(snapshot([finding("a", "none")]), "semver")).toStartWith("error");
});

test("CalVer counts the day's releases from 0", () => {
  const today = snapshot([finding("a", "patch")], { releaseTag: "20261109.0" });

  const earlier = snapshot([finding("a", "patch")], {
    releaseTag: "20261101.3",
  });

  expect(tag(today, "calver")).toBe("20261109.1");
  expect(tag(earlier, "calver")).toBe("20261109.0");
});

test("a fork takes its upstream's version and counts its own", () => {
  const base = { upstreamBase: "2.0.0" };

  expect(
    tag(
      snapshot([finding("a", "patch")], { ...base, releaseTag: "2.0.0-me.1" }),
      "fork",
    ),
  ).toBe("2.0.0-me.2");
  expect(
    tag(
      snapshot([finding("a", "patch")], { ...base, releaseTag: "1.9.0-me.4" }),
      "fork",
    ),
  ).toBe("2.0.0-me.0");
});

test("a new comparison keeps choices that still apply and drops the rest", () => {
  const first = snapshot([finding("a", "patch"), finding("b", "patch")]);
  const shown = applyReview(first, noDecisions);

  const decisions = {
    findings: { a: "none" as const, gone: "major" as const },
    overall: { comparisonId: shown.comparisonId, impact: "minor" as const },
  };

  const same = accept(first, decisions, first);

  expect(same.decisions.findings).toEqual({ a: "none" });
  expect(same.decisions.overall?.impact).toBe("minor");

  // A new release-relevant change moves the comparison, so the overall goes
  const moved = accept(
    first,
    decisions,
    snapshot([
      finding("a", "patch"),
      finding("b", "patch"),
      finding("c", "patch"),
    ]),
  );

  expect(moved.decisions.overall).toBeNull();

  // An incomplete one keeps the last complete comparison
  const incomplete = accept(
    first,
    decisions,
    snapshot([], { complete: false, errors: ["lost"] }),
  );

  expect(incomplete.snapshot).toBe(first);
  expect(incomplete.error).toContain("lost");
});
