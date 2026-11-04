/**
 * The worker's own settings, read from a JSON file: `$UPKEEP_CONFIG`, or
 * `upkeep/config.json` in the XDG config directory. It holds what can't be
 * derived, such as the checks of a repository that doesn't follow
 * groundwork's tasks. A missing file means every default.
 */
import { Config, Effect, FileSystem, Schema } from "effect";
import { Rule } from "./deps/Policy";

/** How the bump job treats one consumer. */
const BumpRepo = Schema.Struct({
  /** Shell commands run before a push, in place of `mise run check` and `build`. */
  checks: Schema.optionalKey(Schema.Array(Schema.String)),
});

/**
 * Where heal decisions are made: any TypeSafe System One API at `url`, with
 * `$UPKEEP_DECISION_API_KEY` when it needs one, Clef on Cloudflare Workers AI
 * with `$CLOUDFLARE_ACCOUNT_ID` and `$CLOUDFLARE_API_TOKEN`, or an LLM through
 * OpenCode, `provider/model#variant`, which needs no decision model at all.
 */
const DecisionModel = Schema.Union([
  Schema.Struct({
    provider: Schema.Literal("typesafe"),
    url: Schema.String,
    model: Schema.String,
  }),
  Schema.Struct({
    provider: Schema.Literal("opencode"),
    model: Schema.String,
  }),
  Schema.Struct({
    provider: Schema.Literal("cloudflare"),
    model: Schema.String,
  }),
]);

export type DecisionModel = typeof DecisionModel.Type;

/** An OpenCode model and variant a heal can hand a fix to, and when to. */
const Agent = Schema.Struct({
  model: Schema.String,
  variant: Schema.optionalKey(Schema.String),
  /** What it's for, which the decision model reads to pick one. */
  for: Schema.String,
});

export type Agent = typeof Agent.Type;

export const Settings = Schema.Struct({
  deps: Schema.optionalKey(
    Schema.Struct({
      /**
       * Upkeep's own rules, applied after the updater's, so they win. Each
       * matches and sets what an updater's rules do, such as `automerge`.
       */
      rules: Schema.optionalKey(Schema.Array(Rule)),
    }),
  ),
  bump: Schema.optionalKey(
    Schema.Struct({
      /** By repository, as `owner/name`. */
      repos: Schema.optionalKey(Schema.Record(Schema.String, BumpRepo)),
    }),
  ),
  heal: Schema.optionalKey(
    Schema.Struct({
      decisions: Schema.optionalKey(DecisionModel),
      /** The agents a fix can go to; the first is the default. */
      agents: Schema.optionalKey(Schema.Array(Agent)),
      /** How long an agent has to fix a run, 30 minutes by default. */
      sessionMinutes: Schema.optionalKey(
        Schema.Number.check(Schema.isGreaterThan(0)),
      ),
      /** The OpenCode command an agent runs in, `opencode2` by default. */
      opencode: Schema.optionalKey(Schema.String),
      /**
       * How many heals a day, across every worker, the decision model is
       * asked about. Unlimited by default, or 300 for the `opencode`
       * provider; set it for a cloud model on a shared or metered plan.
       * Past it, heals are left for the digest.
       */
      decisionsPerDay: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      ),
      /** Upkeep's own repository, `timmo001/upkeep` by default. */
      repo: Schema.optionalKey(Schema.String),
      /**
       * The Plannotator command asks and the daily digest go through,
       * `plannotator` by default, or `false` to send nothing.
       */
      inbox: Schema.optionalKey(
        Schema.Union([Schema.String, Schema.Literal(false)]),
      ),
      /** The folder whose Inbox project they go to, the home folder by default. */
      inboxProject: Schema.optionalKey(Schema.String),
    }),
  ),
});

export type Settings = typeof Settings.Type;

const path = Config.String("UPKEEP_CONFIG").pipe(
  Config.orElse(() =>
    Config.String("XDG_CONFIG_HOME").pipe(
      Config.orElse(() =>
        Config.String("HOME").pipe(Config.map((home) => `${home}/.config`)),
      ),
      Config.map((root) => `${root}/upkeep/config.json`),
    ),
  ),
);

/** Read the settings, or the defaults when there's no file. */
export const load = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* path;

  if (!(yield* fs.exists(file))) return {} satisfies Settings;

  return yield* fs
    .readFileString(file)
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Settings)),
      ),
    );
});
