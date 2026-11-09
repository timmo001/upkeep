/**
 * How a release comparison is reviewed and numbered, shared by the worker,
 * which hashes the evidence it finds, and the server, which keeps your
 * choices and applies them. Evidence hashes match what `dot git releases`
 * made, so choices carried over from it still apply. It needs `node:crypto`,
 * so it's its own entry point, which the dashboard doesn't import.
 */
import { createHash } from "node:crypto";
import { Predicate, Result, type Schema } from "effect";
import type {
  Impact,
  ReleaseDecisions,
  ReleaseEntry,
  ReleaseScan,
  ReleaseSnapshot,
  Versioning,
} from "./Domain";

/**
 * A JSON value, where an object's optional field can be left out or
 * undefined, as the domain's types have them.
 */
export type Evidence =
  | Schema.Json
  | undefined
  | ReadonlyArray<Evidence>
  | { readonly [key: string]: Evidence };

/** A value written out the same way every time: object keys in order. */
export const canonical = (value: Evidence): string => {
  if (value === undefined) return "undefined";

  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;

  if (Predicate.isObject(value))
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;

  return JSON.stringify(value);
};

/** A value's identity: the SHA-256 of its canonical form. */
export const evidenceId = (value: Evidence) =>
  createHash("sha256").update(canonical(value)).digest("hex");

const impacts: ReadonlyArray<Impact> = ["none", "patch", "minor", "major"];

/** Whether `impact` is at least `minimum`. */
export const atLeast = (impact: Impact, minimum: Impact) =>
  impacts.indexOf(impact) >= impacts.indexOf(minimum);

/** The highest of some impacts, or `none`. */
export const highestImpact = (all: ReadonlyArray<Impact>): Impact =>
  all.reduce<Impact>(
    (highest, impact) => (atLeast(highest, impact) ? highest : impact),
    "none",
  );

export const noDecisions: ReleaseDecisions = { findings: {}, overall: null };

/** Whether a finding counts towards a release: a policy or you gave it one. */
const relevant = (finding: ReleaseSnapshot["findings"][number]) =>
  finding.automaticImpact !== "none" ||
  finding.impact !== "none" ||
  finding.reviewed;

/**
 * A comparison with your choices applied, and the identities that hang off
 * them: `comparisonId` for an overall choice, from the release-relevant
 * evidence only, and `id`, which any action on the page is bound to.
 */
export const applyReview = (
  snapshot: ReleaseSnapshot,
  decisions: ReleaseDecisions,
): ReleaseSnapshot => {
  const findings = snapshot.findings.map((finding) => ({
    ...finding,
    impact: decisions.findings[finding.id] ?? finding.automaticImpact,
    reviewed: decisions.findings[finding.id] !== undefined,
  }));

  const comparisonId = evidenceId([
    snapshot.repo,
    snapshot.branch,
    snapshot.releaseCommit,
    snapshot.policyId,
    findings
      .filter(relevant)
      .map((finding) => [finding.id, finding.automaticImpact])
      .toSorted(([a = ""], [b = ""]) => a.localeCompare(b)),
  ]);

  const overall =
    decisions.overall?.comparisonId === comparisonId
      ? decisions.overall.impact
      : undefined;

  const suggestion =
    overall ?? highestImpact(findings.map((finding) => finding.impact));

  const id = evidenceId([
    snapshot.repo,
    snapshot.branch,
    snapshot.releaseCommit,
    snapshot.head,
    snapshot.policyId,
    ...(snapshot.upstreamBase === undefined ? [] : [snapshot.upstreamBase]),
    findings.map((finding) => [
      finding.id,
      finding.complete,
      finding.impact,
      finding.reviewed,
    ]),
    overall ?? null,
    snapshot.complete,
  ]);

  return {
    ...snapshot,
    findings,
    comparisonId,
    id,
    suggestion,
    reviewed: overall !== undefined,
  };
};

/** The release-relevant evidence of a comparison, without its policy. */
const reviewEvidence = (snapshot: ReleaseSnapshot) =>
  evidenceId([
    snapshot.repo,
    snapshot.branch,
    snapshot.releaseCommit,
    snapshot.findings
      .filter(relevant)
      .map((finding) => finding.id)
      .toSorted(),
  ]);

/**
 * Take a new comparison. An incomplete one keeps the last complete one, with
 * an error saying what's missing. A complete one drops choices for findings
 * that are gone, and the overall choice once its evidence changed; one only
 * the policy moved, such as an upgrade, keeps it.
 */
export const accept = (
  previous: ReleaseSnapshot | null,
  decisions: ReleaseDecisions,
  candidate: ReleaseSnapshot,
) => {
  if (!candidate.complete) {
    const missing =
      candidate.errors.join("; ") ||
      candidate.findings
        .filter((finding) => !finding.complete)
        .map((finding) => finding.detail)
        .join("; ") ||
      "missing evidence";

    return {
      snapshot: previous?.complete === true ? previous : candidate,
      decisions,
      error: `Incomplete release comparison: ${missing}`,
    };
  }

  const current = new Set(candidate.findings.map((finding) => finding.id));

  const retained: ReleaseDecisions = {
    ...decisions,
    findings: Object.fromEntries(
      Object.entries(decisions.findings).filter(([id]) => current.has(id)),
    ),
  };

  const next = applyReview(candidate, retained);
  const before = previous === null ? null : applyReview(previous, decisions);

  if (
    before !== null &&
    retained.overall !== null &&
    retained.overall.comparisonId === before.comparisonId &&
    reviewEvidence(before) === reviewEvidence(next)
  ) {
    return {
      snapshot: candidate,
      decisions: {
        ...retained,
        overall: { ...retained.overall, comparisonId: next.comparisonId },
      },
      error: null,
    };
  }

  return {
    snapshot: candidate,
    decisions:
      retained.overall !== null &&
      retained.overall.comparisonId !== next.comparisonId
        ? { ...retained, overall: null }
        : retained,
    error: null,
  };
};

/**
 * Choose an impact for findings, or `overall` for the whole comparison, or
 * clear a choice with `auto`. Fails for a finding that isn't in it.
 */
export const review = (
  snapshot: ReleaseSnapshot,
  decisions: ReleaseDecisions,
  targets: ReadonlyArray<string>,
  impact: Impact | "auto",
): Result.Result<ReleaseDecisions, string> => {
  let next = decisions;

  for (const target of targets) {
    if (target === "overall") {
      next = {
        ...next,
        overall:
          impact === "auto"
            ? null
            : { comparisonId: snapshot.comparisonId, impact },
      };

      continue;
    }

    if (!snapshot.findings.some((finding) => finding.id === target))
      return Result.fail(
        "That change isn't in this comparison any more; refresh the page",
      );

    const findings = { ...next.findings };

    if (impact === "auto") delete findings[target];
    else findings[target] = impact;

    next = { ...next, findings };
  }

  return Result.succeed(next);
};

const plain = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Compare two plain `X.Y.Z` versions. */
const compareVersions = (a: string, b: string) => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);

  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) return Math.sign(difference);
  }

  return 0;
};

/** The next tag of a fork, from its upstream's version and its own count. */
const forkTag = (
  snapshot: ReleaseSnapshot,
  fork: ReleaseScan["fork"],
): Result.Result<string, string> => {
  if (
    fork === null ||
    snapshot.suggestion === "none" ||
    snapshot.upstreamBase === undefined
  )
    return Result.fail(
      "Choose an impact and refresh the upstream base before a release",
    );

  if (
    !plain.test(snapshot.upstreamBase) ||
    snapshot.upstreamBase
      .split(".")
      .some((part) => !Number.isSafeInteger(Number(part)))
  )
    return Result.fail(
      "The upstream base must be a plain X.Y.Z version; refresh the comparison",
    );

  if (snapshot.releaseTag === null)
    return Result.succeed(`${snapshot.upstreamBase}-${fork.suffix}.0`);

  const match =
    /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-([0-9A-Za-z-]+)\.(0|[1-9]\d*))?$/.exec(
      snapshot.releaseTag,
    );

  if (
    match === null ||
    match[1] === undefined ||
    (match[2] !== undefined && match[2] !== fork.suffix)
  )
    return Result.fail(
      `The fork's last release must be X.Y.Z or X.Y.Z-${fork.suffix}.N, without a v`,
    );

  const order = compareVersions(snapshot.upstreamBase, match[1]);

  if (order < 0)
    return Result.fail(
      "The upstream base is older than the fork's last release; reconcile them first",
    );

  const count = match[3] === undefined ? undefined : Number(match[3]);
  const next = order === 0 && count !== undefined ? count + 1 : 0;

  if (!Number.isSafeInteger(next))
    return Result.fail("Fork release counts must be safe integers");

  return Result.succeed(`${snapshot.upstreamBase}-${fork.suffix}.${next}`);
};

/** The next `YYYYMMDD.N` tag on `now`'s UTC date. */
const calverTag = (
  snapshot: ReleaseSnapshot,
  now: number,
): Result.Result<string, string> => {
  const today = new Date(now).toISOString().slice(0, 10);

  if (snapshot.releaseTag === null)
    return Result.succeed(`${today.replaceAll("-", "")}.0`);

  const match = /^(v?)(\d{4})(\d{2})(\d{2})\.(0|[1-9]\d*)$/.exec(
    snapshot.releaseTag,
  );

  if (match === null)
    return Result.fail(
      "The last release isn't a YYYYMMDD.N version to count on from",
    );

  const [, prefix = "", year = "", month = "", day = "", counted = ""] = match;
  const date = `${year}-${month}-${day}`;
  const baseline = new Date(`${date}T00:00:00.000Z`);

  if (
    Number(year) < 1 ||
    Number.isNaN(baseline.getTime()) ||
    baseline.toISOString().slice(0, 10) !== date
  )
    return Result.fail("The last release's date isn't a real date");

  if (date > today)
    return Result.fail(
      "The last release is dated in the future; reconcile it first",
    );

  const next = date === today ? Number(counted) + 1 : 0;

  if (!Number.isSafeInteger(next))
    return Result.fail("CalVer release counts must be safe integers");

  return Result.succeed(`${prefix}${today.replaceAll("-", "")}.${next}`);
};

/** The next SemVer tag, moved by the suggested impact. */
const semverTag = (
  snapshot: ReleaseSnapshot,
): Result.Result<string, string> => {
  if (snapshot.releaseTag === null)
    return Result.succeed(snapshot.suggestion === "major" ? "1.0.0" : "0.1.0");

  const match = /^(v?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(
    snapshot.releaseTag,
  );

  if (match === null)
    return Result.fail(
      "The last release isn't a plain SemVer version to count on from",
    );

  const [, prefix = "", ...parts] = match;
  let [major = 0, minor = 0, patch = 0] = parts.map(Number);

  if (snapshot.suggestion === "major") {
    major++;
    minor = 0;
    patch = 0;
  } else if (snapshot.suggestion === "minor") {
    minor++;
    patch = 0;
  } else patch++;

  return Result.succeed(`${prefix}${major}.${minor}.${patch}`);
};

/**
 * The tag a release of this comparison takes, or why there's none. SemVer
 * moves by the suggested impact, from `0.1.0` (or `1.0.0` for a major) before
 * the first release. CalVer is `YYYYMMDD.N` on `now`'s UTC date, N counting
 * the day's releases from 0. A fork takes its upstream's version with its own
 * suffix and a count, such as `1.2.3-me.0`.
 */
export const nextTag = (
  snapshot: ReleaseSnapshot,
  versioning: Versioning,
  fork: ReleaseScan["fork"],
  now: number,
): Result.Result<string, string> => {
  if (versioning === "fork" || versioning === "fork-base-js")
    return forkTag(snapshot, fork);

  if (snapshot.suggestion === "none")
    return Result.fail("Nothing suggests a release; choose an impact first");

  return versioning === "calver"
    ? calverTag(snapshot, now)
    : semverTag(snapshot);
};

/**
 * A repository as the Releases page shows it: its last comparison with your
 * choices applied, stale when the last scan failed or the policy or branch
 * has moved on from it, and the tag a release would take now.
 */
export const entry = (
  scan: ReleaseScan,
  decisions: ReleaseDecisions,
  now: number,
): ReleaseEntry => {
  const snapshot =
    scan.snapshot === null ? null : applyReview(scan.snapshot, decisions);

  const moved =
    snapshot !== null &&
    (snapshot.branch !== scan.branch || snapshot.policyId !== scan.policyId);

  const stale = scan.error !== null || moved;

  const version: Result.Result<string, string> =
    snapshot === null
      ? Result.fail("There's no comparison yet")
      : stale || !snapshot.complete
        ? Result.fail("Refresh for a complete, current comparison first")
        : nextTag(snapshot, scan.versioning, scan.fork, now);

  return {
    repo: scan.repo,
    name: scan.name,
    branch: scan.branch,
    snapshot,
    stale,
    error:
      scan.error ??
      (moved
        ? "The release policy or branch changed; refresh the comparison"
        : null),
    attemptedAt: scan.attemptedAt,
    needsRelease: snapshot !== null && snapshot.suggestion !== "none",
    nextVersion: Result.isSuccess(version) ? version.success : null,
    versionError: Result.isFailure(version) ? version.failure : null,
    versioning: scan.versioning,
    notify: scan.notify,
    recipe: scan.recipe,
  };
};
