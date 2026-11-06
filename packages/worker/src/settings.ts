/**
 * The worker's own settings, read from a JSON file: `$UPKEEP_CONFIG`, or
 * `upkeep/config.json` in the XDG config directory. It holds what can't be
 * derived, such as the checks of a repository that doesn't follow
 * groundwork's tasks. A missing file means every default.
 */
import { Domain } from "@upkeep/api";
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

/** What the attention job reads beyond what involves you, and how it sorts it. */
const Attention = Schema.Struct({
  /**
   * More GitHub searches to follow, such as an area of a project you work
   * in. `{since}` is replaced with the date `staleDays` ago.
   */
  searches: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Sites whose items are work rather than personal, such as
   * `github.com/some-org` or `*.example.com`.
   */
  work: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Sites to leave out, in the same form. */
  exclude: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Labels whose pull requests and issues are left out, such as `wontfix`,
   * matched without regard to case.
   */
  ignoreLabels: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Days without activity before your own item is going stale, 14 by default. */
  staleDays: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  /**
   * A command that says whether it's work time, printing `{ "work": true }`,
   * so the page opens on work or personal to match.
   */
  workTime: Schema.optionalKey(
    Schema.Struct({
      command: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
    }),
  ),
  /**
   * The OpenCode model and variant the context agent runs on, best a quick
   * one; the first of `heal.agents` by default.
   */
  agent: Schema.optionalKey(
    Schema.Struct({
      model: Schema.String,
      variant: Schema.optionalKey(Schema.String),
    }),
  ),
  /**
   * How this worker opens an agent for you from the Attention page, which it
   * offers only with this set. `command` runs in the checkout with `{brief}`
   * (the brief's file), `{directory}`, `{repo}` (`owner/name`), `{name}` and
   * `{title}` replaced. `directory` is where your checkouts are, with
   * `{owner}` and `{name}`; one that isn't there is cloned into the cache.
   */
  launch: Schema.optionalKey(
    Schema.Struct({
      command: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
      directory: Schema.optionalKey(Schema.String),
    }),
  ),
});

export type Attention = typeof Attention.Type;

export const Settings = Schema.Struct({
  attention: Schema.optionalKey(Attention),
  /**
   * Opt in to naming tracked repositories from your own list, over their
   * README titles. The watch job runs `command` each time and reads the JSON
   * array it prints, of objects with `github` (`owner/name`) and `name`, such
   * as `["dot", "repo", "list", "--json"]`. A name set by hand is kept.
   */
  names: Schema.optionalKey(
    Schema.Struct({
      command: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
    }),
  ),
  deps: Schema.optionalKey(
    Schema.Struct({
      /**
       * Upkeep's own rules, applied after the updater's, so they win. Each
       * matches and sets what an updater's rules do, such as `automerge`.
       */
      rules: Schema.optionalKey(Schema.Array(Rule)),
      /**
       * Repositories, as `owner/name`, whose updates Upkeep owns are applied,
       * checked and pushed to the default branch, one group at a time. None
       * by default, so the job only plans.
       */
      apply: Schema.optionalKey(Schema.Array(Schema.String)),
      /** Log what applying would push instead of pushing it; on by default. */
      dryRun: Schema.optionalKey(Schema.Boolean),
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
       * Past it, heals are left for you.
       */
      decisionsPerDay: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      ),
      /** Upkeep's own repository, `timmo001/upkeep` by default. */
      repo: Schema.optionalKey(Schema.String),
      /**
       * The Plannotator command a heal that needs you asks through,
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

/** How a decision model is named to the server, `provider/model`. */
export const deciderName = (model: DecisionModel) =>
  `${model.provider}/${model.model}`;

/** An agent as the server keeps it. */
export const agentModel = (agent: Agent): Domain.AgentModel => ({
  model: agent.model,
  variant: agent.variant ?? null,
});

/** The agents in these settings, as the worker tells the server. */
export const agentSetup = (settings: Settings): Domain.AgentSetup => ({
  decisions:
    settings.heal?.decisions === undefined
      ? null
      : deciderName(settings.heal.decisions),
  agents: (settings.heal?.agents ?? []).map((agent) => ({
    model: agent.model,
    variant: agent.variant ?? null,
    for: agent.for,
  })),
  launch: settings.attention?.launch !== undefined,
});

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
