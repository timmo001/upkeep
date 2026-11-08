/**
 * Whether a bump or dependency update needs a regression check before it
 * lands, and what a repository runs for one. The rules read the version
 * change and the release notes: a major, a minor below 1.0 or a breaking
 * change in the notes needs a check, a patch, digest, pin or lockfile-only
 * update doesn't, and anything else is unclear. The decision model settles an
 * unclear one from its notes when there is one, up to a daily limit counted on
 * the server; without it, past the limit or when it fails, an unclear update
 * is checked. Only repositories that opt in are checked; one with no commands
 * to run has the update held for an agent.
 */
import { Clock, Duration, Effect, Option, Schema } from "effect";
import { Decision, DecisionModel } from "effect/ai";
import semver from "semver";
import * as Decisions from "./Decisions";
import type { UpdateType } from "./deps/Policy";
import { reason } from "./Failure";
import { Reporter } from "./Reporter";
import * as RunLog from "./RunLog";
import * as Settings from "./settings";

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

/** How likely an unclear update must be to change the app to be checked, by default. */
export const defaultThreshold = 0.3;

/**
 * Release notes as the decision model reads them: their first lines with
 * text, each cut short, as the heal cuts a run's log. The top of the notes is
 * kept, where releases put what matters most.
 */
export const trimNotes = (notes: string) =>
  notes
    .split("\n")
    .map((text) => text.trimEnd())
    .filter((text) => text.trim() !== "")
    .slice(0, Decisions.maxLines)
    .map((text) => text.slice(0, Decisions.maxMessage))
    .join("\n");

/** What the model's probability comes to: a check at or above the threshold. */
export const verdictOf = (
  probability: number,
  threshold: number,
): Exclude<Verdict, "unclear"> => (probability >= threshold ? "check" : "skip");

/** An update as the decision model reads it, its notes already trimmed. */
const Update = Schema.Struct({
  package: Schema.String,
  from: Schema.String,
  to: Schema.String,
  updateType: Schema.String,
  notes: Schema.String,
});

export type Update = typeof Update.Type;

const statement =
  "could change how an app that uses it looks or behaves, so it should be checked before it lands";

const outcomes = {
  false:
    "A maintenance release: dependency updates, internal refactors, docs, tests or CI, or fixes that keep what people see and do the same",
  true: "New or changed features, screens, styles, defaults, behaviour or APIs that could change what an app using it looks like or does",
};

const Risk = Decision.make({
  input: Schema.Struct({ update: Update }),
  decisions: {
    changes: Decision.probability({
      instructions: `\`update\` ${statement}`,
      criteria: outcomes,
    }),
  },
});

const Answer = Schema.Struct({
  probability: Schema.Number.check(
    Schema.isBetween({ minimum: 0, maximum: 1 }),
  ),
});

/**
 * How many regression decisions the model has left for today, counted on the
 * server across every worker over the last 24 hours, as the heal counts its
 * own. Unlimited by default, or 100 a day through OpenCode.
 */
const decisionsLeft = Effect.fnUntraced(function* (
  model: Settings.DecisionModel,
  settings: Settings.Settings,
) {
  const limit =
    settings.regression?.decisionsPerDay ??
    (model.provider === "opencode" ? 100 : Infinity);

  if (limit === Infinity) return { left: Infinity, limit };

  const reporter = yield* Reporter;
  const now = yield* Clock.currentTimeMillis;

  const used = yield* reporter.regressionDecisions(
    now - Duration.toMillis("1 day"),
    Settings.deciderName(model),
  );

  return { left: limit - used, limit };
});

/** How likely the decision model thinks an update is to change the app. */
const likelihood = Effect.fnUntraced(function* (
  update: Update,
  model: Settings.DecisionModel,
  opencode: string,
) {
  if (model.provider !== "opencode")
    return yield* DecisionModel.DecisionModel.pipe(
      Effect.flatMap((decisions) =>
        decisions.decide(Risk, { input: { update } }),
      ),
      Effect.map(({ answers }) => answers.changes.probability),
      Effect.provide(Decisions.layer(model)),
    );

  const { probability } = yield* Decisions.decideByAgent({
    answer: Answer,
    prompt: [
      `Say how likely this update ${statement}. Don't use any tools: reply with only one line of JSON, \`{"probability": ...}\`, a number from 0 to 1, and nothing else.`,
      "",
      `Unlikely: ${outcomes.false}.`,
      `Likely: ${outcomes.true}.`,
      "",
      "The update:",
      "",
      JSON.stringify(update, null, 2),
    ].join("\n"),
    title: "Upkeep regression decision",
    model,
    opencode,
  });

  return probability;
});

/**
 * Ask the decision model whether an update the rules can't settle needs a
 * check, logging its answer once with the model's name and recording it for
 * the daily limit. None when there's no model, its decisions for today can't
 * be counted or are used up, or it fails, so the rules' verdict stands.
 */
export const ask = Effect.fnUntraced(function* (
  update: Update,
  settings: Settings.Settings,
) {
  const model = settings.heal?.decisions;

  if (model === undefined) return Option.none<Decided>();

  const about = `${update.package} ${update.from} to ${update.to}`;

  // Without a count there's no knowing the limit, so the rules stand
  const room = yield* decisionsLeft(model, settings).pipe(
    Effect.map(Option.some),
    Effect.catchCause((cause) =>
      RunLog.warn(
        `Not asking the decision model about ${about}: couldn't count its regression decisions today: ${reason(cause)}`,
      ).pipe(Effect.as(Option.none<{ left: number; limit: number }>())),
    ),
  );

  if (Option.isNone(room)) return Option.none<Decided>();

  if (room.value.left <= 0) {
    yield* RunLog.info(
      `Not asking the decision model about ${about}: it's made ${room.value.limit} regression decisions today, the limit`,
    );

    return Option.none<Decided>();
  }

  const answer = yield* likelihood(
    update,
    model,
    settings.heal?.opencode ?? "opencode2",
  ).pipe(
    Effect.map(Option.some),
    Effect.catchCause((cause) =>
      RunLog.warn(
        `The decision model couldn't decide whether ${about} needs a regression check: ${reason(cause)}`,
      ).pipe(Effect.as(Option.none<number>())),
    ),
  );

  if (Option.isNone(answer)) return Option.none<Decided>();

  const threshold = settings.regression?.threshold ?? defaultThreshold;
  const verdict = verdictOf(answer.value, threshold);
  const percent = Math.round(answer.value * 100);
  const limit = Math.round(threshold * 100);

  yield* RunLog.info(
    `Decided ${about} ${verdict === "check" ? "needs" : "doesn't need"} a regression check: ${percent}% likely to change how an app looks or behaves, against a ${limit}% threshold (${Decisions.by(model)})`,
  );

  // The decision stands whether or not it's counted
  yield* Reporter.use((reporter) =>
    reporter.regressionDecision({
      package: update.package,
      from: update.from,
      to: update.to,
      model: Settings.deciderName(model),
      probability: answer.value,
      verdict,
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      RunLog.warn(
        `Couldn't record the decision on ${about} for the daily limit: ${reason(cause)}`,
      ),
    ),
  );

  return Option.some<Decided>({
    verdict,
    why: `the decision model gives it a ${percent}% chance of changing how the app looks or behaves, ${verdict === "check" ? "at or over" : "under"} the ${limit}% threshold`,
  });
});

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
