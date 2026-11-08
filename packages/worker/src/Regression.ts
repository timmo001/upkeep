/**
 * Whether a bump or dependency update needs a regression check before it
 * lands, and what a repository runs for one. The rules read the version
 * change and the release notes: a major, a minor below 1.0 or a breaking
 * change in the notes needs a check, a patch, digest, pin or lockfile-only
 * update doesn't, and anything else is unclear. Only repositories that opt in
 * are checked; one with no commands to run has the update held for an agent.
 */
import semver from "semver";
import type { UpdateType } from "./deps/Policy";

/** The mise task a repository opts in with. */
export const task = "regression";

/** A repository's `regression` setting. */
export interface Setting {
  readonly commands?: ReadonlyArray<string>;
}

/**
 * The commands a repository's regression check runs: those in its setting,
 * which wins, or else its mise `regression` task. An empty list means it
 * opted in with nothing to run, so the check is an agent's, and `undefined`
 * that it hasn't opted in.
 */
export const commands = (
  setting: Setting | undefined,
  tasks: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined => {
  if (setting?.commands !== undefined) return setting.commands;

  if (tasks.includes(task)) return [`mise run --force ${task}`];

  return setting === undefined ? undefined : [];
};

/** What an update is, for the rules. */
export interface Change {
  readonly updateType?: UpdateType | undefined;
  /** The version it moves from and to, which set its type when it has none. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  /** Only the lockfile moves, as in lock file maintenance. */
  readonly lockfile?: boolean | undefined;
  /** Its release notes, empty when it has none, or undefined when they couldn't be read. */
  readonly notes?: string | undefined;
}

export type Verdict = "check" | "skip" | "unclear";

export interface Decided {
  readonly verdict: Verdict;
  /** Why, to follow "as" in a log line. */
  readonly why: string;
}

/** The type of a version change, or `undefined` when either isn't a version. */
export const updateTypeOf = (
  from: string | undefined,
  to: string | undefined,
): UpdateType | undefined => {
  const before = semver.coerce(from ?? "");
  const after = semver.coerce(to ?? "");

  if (before === null || after === null) return undefined;

  if (before.major !== after.major) return "major";

  if (before.minor !== after.minor) return "minor";

  return "patch";
};

const skips: Partial<Record<UpdateType, string>> = {
  patch: "a patch",
  digest: "a digest update",
  pin: "a pin",
  pinDigest: "a digest pin",
};

/**
 * What the notes say that suggests a breaking change: a breaking heading or
 * `BREAKING CHANGE:`, a Conventional Commits `!`, a migration, or something
 * removed or deprecated.
 */
const markers = [
  /(?<!non[- ]?)\bbreaking\b/i,
  /^\s*(?:[-*+]\s+)?(?:\*\*)?[a-z]+(?:\([^)]*\))?!:/i,
  /\bmigrat(?:e|es|ed|ing|ion|ions)\b/i,
  /\bremoved\b/i,
  /\bdeprecat(?:e|es|ed|ing|ion)\b/i,
];

/** The first line of the notes marking a breaking change, if any. */
export const breaking = (notes: string) => {
  const line = notes
    .split("\n")
    .find((text) => markers.some((marker) => marker.test(text)))
    ?.trim();

  return line === undefined || line.length <= 100
    ? line
    : `${line.slice(0, 99)}…`;
};

/** The rules' verdict on an update. */
export const decide = (change: Change): Decided => {
  if (change.lockfile === true)
    return { verdict: "skip", why: "only the lockfile moves" };

  if (change.notes?.trim() === "")
    return { verdict: "skip", why: "it has no release notes" };

  const type = change.updateType ?? updateTypeOf(change.from, change.to);
  const skip = type === undefined ? undefined : skips[type];

  if (skip !== undefined) return { verdict: "skip", why: `it's ${skip}` };

  if (type === "major") return { verdict: "check", why: "it's a major update" };

  if (
    type === "minor" &&
    semver.coerce(change.from ?? change.to ?? "")?.major === 0
  )
    return { verdict: "check", why: "it's a minor update below 1.0" };

  if (change.notes === undefined)
    return { verdict: "unclear", why: "its release notes couldn't be read" };

  const marker = breaking(change.notes);

  if (marker !== undefined)
    return { verdict: "check", why: `its release notes say "${marker}"` };

  return {
    verdict: "unclear",
    why: `it's ${type === "minor" ? "a minor update" : "an update"} with nothing breaking in its notes`,
  };
};

/**
 * What a held update's log line says after its repository, which the fix
 * prompt looks for.
 */
export const needsCheck = "needs a regression check";

/**
 * The log line, after `${repo}: `, for an update that needs a check: against
 * which release, why, what came of it, and where the release notes and
 * changes are.
 */
export const line = (options: {
  readonly against: string;
  readonly why: string;
  readonly outcome: string;
  readonly notes?: string | undefined;
  readonly compare?: string | undefined;
}) => {
  const links = [
    ...(options.notes === undefined ? [] : [`Release notes: ${options.notes}`]),
    ...(options.compare === undefined ? [] : [`compare: ${options.compare}`]),
  ].join(", ");

  return [
    `${needsCheck} against ${options.against}, as ${options.why}, ${options.outcome}.`,
    links === "" ? "" : ` ${links.charAt(0).toUpperCase()}${links.slice(1)}.`,
  ].join("");
};
