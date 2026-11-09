/**
 * The worker's own settings, read from a JSON file: `$UPKEEP_CONFIG`, or
 * `upkeep/config.json` in the XDG config directory. It holds what can't be
 * derived, such as the checks of a repository that doesn't follow
 * groundwork's tasks. A missing file means every default.
 */
import { Domain } from "@upkeep/api";
import { Config, DateTime, Effect, FileSystem, Schema } from "effect";
import { Rule } from "./deps/Policy";

/** How the bump job treats one consumer. */
const BumpRepo = Schema.Struct({
  /** Shell commands run before a push, in place of `mise run check` and `build`. */
  checks: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Shell commands that rebuild committed files from the dependencies, such
   * as `mise run bundle`, run after an install and before the checks. The
   * tracked files they change go in the update's commit.
   */
  generate: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Opt in to regression checks: an update whose version change or release
   * notes say it could change how the app looks or behaves runs `commands`
   * before the push, in place of the repository's mise `regression` task. With
   * neither, the update is held and handed to an agent.
   */
  regression: Schema.optionalKey(
    Schema.Struct({
      commands: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});

/**
 * Where heal and regression check decisions are made: any TypeSafe System
 * One API at `url`, with `$UPKEEP_DECISION_API_KEY` when it needs one, Clef on
 * Cloudflare Workers AI with `$CLOUDFLARE_ACCOUNT_ID` and
 * `$CLOUDFLARE_API_TOKEN`, or an LLM through OpenCode, `provider/model#variant`,
 * which needs no decision model at all.
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
   * (the brief's file), `{directory}`, `{repo}` (`owner/name`), `{name}` (the
   * name `names` gives it, or the repository's own) and `{title}` replaced.
   * The checkout is the one `names` gives, where it prints a `path`, or else
   * from `directory`, where your checkouts are, with `{owner}` and `{name}`;
   * one that isn't there yet is cloned there.
   */
  launch: Schema.optionalKey(
    Schema.Struct({
      command: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
      directory: Schema.optionalKey(Schema.String),
    }),
  ),
  /**
   * How this worker opens an agent's OpenCode session for you, from a heal's
   * run or a skill change. `command` runs in the directory the agent worked
   * in, with `{session}`, `{directory}`, `{name}` (the directory's last
   * folder) and `{title}` replaced.
   */
  resume: Schema.optionalKey(
    Schema.Struct({
      command: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
    }),
  ),
});

export type Attention = typeof Attention.Type;

/**
 * A rule that sets the impact of the changes it matches, ahead of the
 * policy's own. Fields are ANDed, the values in one ORed.
 */
const ReleaseRule = Schema.Struct({
  /** Globs of repository paths, matching a renamed file's old path too. */
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
  changeTypes: Schema.optionalKey(
    Schema.Array(Schema.Literals(["added", "modified", "deleted", "renamed"])),
  ),
  /** Dependency names, exactly. */
  dependencies: Schema.optionalKey(Schema.Array(Schema.String)),
  roles: Schema.optionalKey(Schema.Array(Domain.DependencyRole)),
  /** Submodule paths. */
  submodules: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Regular expressions for the subjects of the commits behind a change. */
  subjects: Schema.optionalKey(Schema.Array(Schema.String)),
  impact: Domain.Impact,
  reason: Schema.String,
});

export type ReleaseRule = typeof ReleaseRule.Type;

/** How the unreleased job reads one repository. */
const ReleaseRepo = Schema.Struct({
  /** The branch to compare with its last stable release; the default branch by default. */
  branch: Schema.optionalKey(Schema.String),
  /** What counts as shipped: `application` by default. */
  policy: Schema.optionalKey(
    Schema.Literals(["application", "oxlint-rules", "system-bridge"]),
  ),
  /** How releases are numbered: `semver` by default. */
  versioning: Schema.optionalKey(Domain.Versioning),
  /**
   * For `fork` and `fork-base-js`: the upstream, as `owner/name`, whose
   * plain SemVer tags (or merged `package.json`) give the base version, and
   * the suffix the fork's own releases count under.
   */
  fork: Schema.optionalKey(
    Schema.Struct({
      upstream: Schema.String.check(
        Schema.isPattern(
          /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/,
        ),
      ),
      suffix: Schema.String.check(
        Schema.isPattern(/^(?![0-9]+$)[0-9A-Za-z-]+$/),
      ),
    }),
  ),
  /**
   * Changed lines of shipped source above which a release is suggested as
   * minor; off without it.
   */
  sourceMinorThreshold: Schema.optionalKey(Schema.Finite),
  /** Globs left out of that count. */
  sourceExcludes: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Rules applied before the policy's own, the first match winning. */
  overrides: Schema.optionalKey(Schema.Array(ReleaseRule)),
  /**
   * Whether a suggested release needs you, through `notify`, and from what
   * impact; on, from `patch`, by default.
   */
  notify: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      minimumImpact: Schema.optionalKey(Domain.Impact),
    }),
  ),
}).check(
  Schema.makeFilter((repo) =>
    (repo.versioning === "fork" || repo.versioning === "fork-base-js") &&
    repo.fork === undefined
      ? `versioning ${repo.versioning} needs fork.upstream and fork.suffix`
      : undefined,
  ),
);

export type ReleaseRepo = typeof ReleaseRepo.Type;

/**
 * How this worker tells you something new needs you, such as a heal that
 * asked, a parked job or a skill change waiting. `command` runs once for each,
 * with `{title}` and `{url}` (its dashboard page) replaced, such as
 * `notify-send`. `dashboard` is where the pages are, `$UPKEEP_SERVER` by
 * default; set it to the Home Assistant sidebar's address to open them there.
 */
const Notify = Schema.Struct({
  command: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  dashboard: Schema.optionalKey(Schema.String),
});

export type Notify = typeof Notify.Type;

/** A time of day on the worker's clock, `HH:MM`. */
const TimeOfDay = Schema.String.check(
  Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
);

/**
 * Hours the worker rests, such as overnight: from `start` until `end`, on its
 * own clock, wrapping past midnight when `end` is earlier. It takes no new
 * runs then except what the dashboard asks for, and holds its notifications.
 */
const QuietHours = Schema.Struct({ start: TimeOfDay, end: TimeOfDay });

export type QuietHours = typeof QuietHours.Type;

export const Settings = Schema.Struct({
  attention: Schema.optionalKey(Attention),
  notify: Schema.optionalKey(Notify),
  quietHours: Schema.optionalKey(QuietHours),
  /**
   * Opt in to naming tracked repositories from your own list, over their
   * README titles. The watch job runs `command` each time and reads the JSON
   * array it prints, of objects with `github` (`owner/name`) and `name`, such
   * as `["dot", "repo", "list", "--json"]`. A name set by hand is kept. An
   * agent opened for a repository is named the same, and one from the
   * Attention or Releases page starts in the object's `path` when it has one.
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
  releases: Schema.optionalKey(
    Schema.Struct({
      /**
       * By repository, as `owner/name`. A repository tracked for the
       * unreleased job without one takes every default.
       */
      repos: Schema.optionalKey(Schema.Record(Schema.String, ReleaseRepo)),
    }),
  ),
  regression: Schema.optionalKey(
    Schema.Struct({
      /**
       * How likely, from 0 to 1, the decision model must think an update the
       * rules can't settle is to change how an app looks or behaves before
       * it's checked. At or above it the update is checked, below it isn't.
       * 0.3 by default, leaning towards a check, as a missed regression costs
       * more than a check. Without a model, or when it fails, it's checked.
       */
      threshold: Schema.optionalKey(
        Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
      ),
      /**
       * How many updates a day, across every worker, the decision model is
       * asked about, counted apart from `heal.decisionsPerDay`. Unlimited by
       * default, or 100 for the `opencode` provider; set it for a cloud
       * model on a shared or metered plan. Past it, an unclear update is
       * checked.
       */
      decisionsPerDay: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      ),
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
       * How many heals this worker runs at once, 3 by default. Two never work
       * on the same repository at the same time.
       */
      sessions: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
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
       * A command the worker runs when a heal ends with a session that needs
       * you, such as a tool that parks a session for another machine. It
       * runs in the directory the agent worked in, with `{session}`,
       * `{directory}`, `{name}` (the directory's last folder) and `{title}`
       * filled in. Its failing is logged, and the heal still needs you.
       */
      handOff: Schema.optionalKey(
        Schema.Struct({
          command: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
        }),
      ),
    }),
  ),
  skills: Schema.optionalKey(
    Schema.Struct({
      /**
       * The OpenCode model and variant that changes skills for your
       * approval; the first of `heal.agents` by default.
       */
      agent: Schema.optionalKey(
        Schema.Struct({
          model: Schema.String,
          variant: Schema.optionalKey(Schema.String),
        }),
      ),
      /** How long the agent has for a change, 30 minutes by default. */
      sessionMinutes: Schema.optionalKey(
        Schema.Number.check(Schema.isGreaterThan(0)),
      ),
      /**
       * Other repositories whose skills the Skills page shows, beside the
       * shared skills repository: `repo` as `owner/name`, and `path`, the
       * folder in it that holds one folder per skill.
       */
      repos: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({ repo: Schema.String, path: Schema.String }),
        ),
      ),
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

/**
 * The OpenCode command these settings run decisions or agents in, or null
 * when they need none.
 */
export const openCodeCommand = (settings: Settings) =>
  settings.heal?.decisions?.provider === "opencode" ||
  (settings.heal?.agents ?? []).length > 0
    ? (settings.heal?.opencode ?? "opencode2")
    : null;

/** Minutes past midnight of an `HH:MM` time. */
const minutesOf = (time: string) => {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);

  return hours * 60 + minutes;
};

/** Whether `at`, in milliseconds, falls in the quiet hours on the local clock. */
export const isQuiet = (hours: QuietHours, at: number) => {
  const local = DateTime.makeZonedUnsafe(at, {
    timeZone: DateTime.zoneMakeLocal(),
  });

  const now =
    DateTime.getPart(local, "hour") * 60 + DateTime.getPart(local, "minute");

  const start = minutesOf(hours.start);
  const end = minutesOf(hours.end);

  return start <= end ? now >= start && now < end : now >= start || now < end;
};

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
  resume: settings.attention?.resume !== undefined,
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
