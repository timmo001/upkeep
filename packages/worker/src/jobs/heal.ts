/**
 * The heal job: read a failed or lost run and its log, and choose what to do
 * with a decision model, or an LLM through OpenCode: run it again, hand a fix
 * to an agent in an OpenCode session in Herdr, park the job, or leave it for
 * the digest. Whatever it chooses goes in the heal's record. Without a
 * decision model in the settings, a lost run is retried and anything else
 * waits for the digest.
 */
import {
  CloudflareClient,
  CloudflareDecisionModel,
} from "@effect/ai-cloudflare";
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import { Domain } from "@upkeep/api";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import {
  Cause,
  Clock,
  Config,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";
import { Decision, DecisionModel } from "effect/ai";
import * as Inbox from "../Inbox";
import { Reporter, type Healing } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { run as exec } from "./bump";
import { fix } from "./fix";

/** The longest log line or error the model reads. */
const maxMessage = 300;

/** How many of the run's last log lines the model reads. */
const maxLines = 40;

const Failure = Schema.Struct({
  failed: Schema.Struct({
    job: Schema.String,
    trigger: Domain.Trigger,
    target: Schema.String,
    error: Schema.String,
    log: Schema.Array(Schema.String),
    /** How the same or similar failures went before, from triage's notes. */
    before: Schema.Array(Schema.String),
  }),
});

type Failure = typeof Failure.Type;

const actions = {
  retry:
    "A temporary problem, such as the network, GitHub, a rate limit or a lost worker, that running the job again should get past",
  fix: "A real fault in the code, a test or a consumer's checks, that an agent can fix with a commit",
  park: "It will keep failing until something outside changes, such as a missing token, permission or tool, so stop running the job",
  ask: "It isn't clear what went wrong or what to do, so a person should look",
} satisfies Record<Domain.HealDecision, string>;

const Action = Decision.make({
  input: Failure,
  decisions: {
    action: Decision.classify({
      instructions: "What should be done about `failed`, a failed job run?",
      criteria: actions,
    }),
  },
});

interface Chosen {
  readonly decision: Domain.HealDecision;
  readonly reason: string;
  readonly agent: Option.Option<Settings.Agent>;
  /** Whether a decision model chose it, rather than the fallback. */
  readonly decided: boolean;
}

const label = (agent: Settings.Agent) =>
  agent.variant === undefined ? agent.model : `${agent.model}#${agent.variant}`;

type ModelDecisions = Exclude<
  Settings.DecisionModel,
  { readonly provider: "opencode" }
>;

const decisionLayer = (options: ModelDecisions) =>
  options.provider === "cloudflare"
    ? CloudflareDecisionModel.layer({ model: options.model }).pipe(
        Layer.provide(CloudflareClient.layerConfig()),
      )
    : TypeSafeDecisionModel.layer({ model: options.model }).pipe(
        Layer.provide(
          TypeSafeClient.layerConfig({
            apiUrl: Config.succeed(options.url),
            apiKey: Config.Redacted("UPKEEP_DECISION_API_KEY").pipe(
              Config.withDefault(undefined),
            ),
          }),
        ),
      );

/**
 * The log lines about the heal's target: for a consumer, the ones naming its
 * repository, so a run over many repositories reads as this one's failure.
 * Anything else, or a consumer the log never names, gets the whole tail.
 */
export const relevant = (
  heal: Domain.Heal,
  log: ReadonlyArray<Domain.LogLine>,
) => {
  if (heal.target.kind === "upkeep") return log;

  const { repo } = heal.target;

  const about = log.filter(
    ({ message }) =>
      message.startsWith(`${repo}:`) || message.startsWith(`${repo}#`),
  );

  return about.length === 0 ? log : about;
};

/** What the model reads: the run, its error, the end of its log and precedents. */
export const describe = (
  heal: Domain.Heal,
  run: Domain.Run,
  log: ReadonlyArray<Domain.LogLine>,
  precedents: ReadonlyArray<Domain.Precedent> = [],
): Failure => ({
  failed: {
    job: run.job,
    trigger: run.trigger,
    target: heal.target.kind === "upkeep" ? "upkeep" : heal.target.repo,
    error: (run.error ?? "").slice(0, maxMessage),
    log: relevant(heal, log)
      .slice(-maxLines)
      .map((line) => `${line.level}: ${line.message.slice(0, maxMessage)}`),
    before: precedents.flatMap((precedent) =>
      precedent.notes.map(
        (note) =>
          `${precedent.title} (${precedent.state}): ${note.slice(0, maxMessage)}`,
      ),
    ),
  },
});

/** What to do without a decision model: retry a lost run, ask about the rest. */
export const fallback = (
  run: Domain.Run,
  why = "there's no decision model",
): Chosen =>
  run.error?.startsWith("Lost") === true
    ? {
        decision: "retry",
        reason: `The worker was lost, and ${why}`,
        agent: Option.none(),
        decided: false,
      }
    : {
        decision: "ask",
        reason: `Nothing chose, as ${why}`,
        agent: Option.none(),
        decided: false,
      };

/** How a heal's reason names the model that chose it, to count its use. */
const by = (model: Settings.DecisionModel) =>
  `by ${model.provider}/${model.model}`;

/** Ask the model, picking an agent too when it chooses a fix. */
const decide = Effect.fnUntraced(function* (
  failure: Failure,
  agents: ReadonlyArray<Settings.Agent>,
  model: Settings.DecisionModel,
) {
  const decisions = yield* DecisionModel.DecisionModel;
  const { answers } = yield* decisions.decide(Action, { input: failure });
  const { label: decision, probabilities } = answers.action;
  const sure = Math.round(probabilities[decision] * 100);
  const reason = `${actions[decision]} (${sure}% sure, ${by(model)})`;

  if (decision !== "fix" || agents.length < 2) {
    return {
      decision,
      reason,
      agent: Option.fromNullishOr(decision === "fix" ? agents[0] : undefined),
      decided: true,
    } satisfies Chosen;
  }

  const Pick = Decision.make({
    input: Failure,
    decisions: {
      agent: Decision.classify({
        instructions: "Which agent should fix `failed`?",
        criteria: Object.fromEntries(
          agents.map((agent) => [label(agent), agent.for]),
        ),
      }),
    },
  });

  const picked = yield* decisions.decide(Pick, { input: failure });

  return {
    decision,
    reason,
    agent: Option.fromNullishOr(
      agents.find((agent) => label(agent) === picked.answers.agent.label),
    ),
    decided: true,
  } satisfies Chosen;
});

const Answer = Schema.Struct({
  action: Domain.HealDecision,
  agent: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/**
 * Ask an LLM through OpenCode instead of a decision model, with the same
 * choices, for a worker that has neither a local model nor free-tier room.
 */
const decideByAgent = Effect.fnUntraced(function* (
  failure: Failure,
  agents: ReadonlyArray<Settings.Agent>,
  model: Settings.DecisionModel,
  opencode: string,
) {
  const prompt = [
    'A job run failed. Choose what to do about it. Don\'t use any tools: reply with only one line of JSON, `{"action": ..., "agent": ...}`, and nothing else.',
    "",
    "Actions:",
    ...Object.entries(actions).map(([name, when]) => `- ${name}: ${when}`),
    "",
    "Agents, for a fix (name one, or null for any other action):",
    ...agents.map((agent) => `- ${label(agent)}: ${agent.for}`),
    "",
    "The failure:",
    "",
    JSON.stringify(failure.failed, null, 2),
  ].join("\n");

  const output = yield* exec(
    opencode,
    ["run", "--model", model.model, "--title", "Upkeep heal decision", prompt],
    { cwd: tmpdir(), trusted: tmpdir() },
  );

  const line = output.match(/\{[^\n]*\}/g)?.at(-1) ?? output;

  const answer = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Answer),
  )(line);

  return {
    decision: answer.action,
    reason: `${actions[answer.action]} (${by(model)})`,
    agent: Option.fromNullishOr(
      answer.action === "fix"
        ? (agents.find((agent) => label(agent) === answer.agent) ?? agents[0])
        : undefined,
    ),
    decided: true,
  } satisfies Chosen;
});

/** The longest stretch of log a message to a person quotes. */
const maxQuote = 3000;

/**
 * Tell a person about a heal through the Inbox, only once there's something
 * for them to do: what failed for this target, in its own log lines rather
 * than the run's summary of every failure, what Upkeep already tried, and the
 * step that's theirs.
 */
const askPerson = (healing: Healing, tried: string, todo: string) => {
  const { heal: record, run, log } = healing;
  const consumer = record.target.kind === "consumer";
  const target = consumer ? record.target.repo : "Upkeep";

  const lines = relevant(record, log)
    .filter(({ level }) => level !== "info" || consumer)
    .map(({ level, message }) =>
      stripVTControlCharacters(
        `${level === "info" ? "" : `${level}: `}${message}`,
      ),
    );

  const quote =
    lines.length > 0
      ? lines.join("\n").slice(-maxQuote)
      : (run.error ?? "(no error)").split("\n")[0];

  return Inbox.send(
    `Upkeep: ${target} needs you (${run.job})`,
    [
      ":::action",
      todo,
      "",
      `${tried}.`,
      ":::",
      "",
      `${run.job} failed for ${target} (run ${run.id}):`,
      "",
      "```text",
      quote,
      "```",
    ].join("\n"),
    `upkeep-heal-${run.id}-${record.of}`,
  );
};

/**
 * Hand a fix to an agent. A person hears about it only when the agent leaves
 * it unfixed, with the session to pick it up from; an agent that couldn't
 * start is left for the digest.
 */
const handOff = Effect.fnUntraced(function* (
  healing: Healing,
  agent: Settings.Agent,
  why: string,
) {
  const reporter = yield* Reporter;
  const { run } = healing;

  const result = yield* fix(
    healing.heal,
    run,
    relevant(healing.heal, healing.log),
    healing.precedents,
    agent,
    (update) => reporter.heal(update),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({
        action: `Left for the digest: the agent couldn't start, ${Cause.pretty(cause).split("\n")[0] ?? ""}`,
        session: null,
        attention: false,
      }),
    ),
  );

  yield* RunLog.info(result.action);
  yield* reporter.heal({ action: result.action });

  if (result.attention && result.session !== null)
    yield* askPerson(
      healing,
      `${why}, so ${label(agent)} worked on it. ${result.action}`,
      `Pick up where the agent stopped: its \`heal ${run.job}\` pane in Herdr, or \`opencode2 --session ${result.session}\`.`,
    );
});

/** Carry out a choice, adding what it did to the heal's record. */
const act = Effect.fnUntraced(function* (
  healing: Healing,
  chosen: Chosen,
  agents: ReadonlyArray<Settings.Agent>,
) {
  const reporter = yield* Reporter;
  const { run } = healing;

  switch (chosen.decision) {
    case "retry": {
      const queued = yield* reporter.retry();

      const action =
        queued === null
          ? `Didn't queue ${run.job} again: it's parked`
          : `Queued ${run.job} again as ${queued.id}`;

      yield* RunLog.info(action);
      yield* reporter.heal({ action });

      return;
    }

    case "park": {
      yield* reporter.park(run.job, chosen.reason, healing.heal.issue);

      const action = `Parked ${run.job}`;

      yield* RunLog.warn(action);
      yield* reporter.heal({ action });

      yield* askPerson(
        healing,
        `${action}: ${chosen.reason}`,
        healing.heal.issue === null
          ? `Fix what stops it, then run \`upkeep unpark ${run.job}\`.`
          : `Fix what stops it, then resolve ${healing.heal.issue} in triage with a note on the fix, which unparks ${run.job}.`,
      );

      return;
    }

    case "fix": {
      if (Option.isNone(chosen.agent)) {
        const action = "Left for the digest: there's no agent to fix it";

        yield* RunLog.warn(action);
        yield* reporter.heal({ action });

        return;
      }

      return yield* handOff(healing, chosen.agent.value, chosen.reason);
    }

    case "ask": {
      // The model isn't sure what's wrong, which is what the last agent, the
      // one for hard fixes, is for. Without one, or a model, it waits for the
      // evening digest.
      const agent = agents.at(-1);

      if (chosen.decided && agent !== undefined)
        return yield* handOff(healing, agent, chosen.reason);

      const action = "Left for the digest";

      yield* RunLog.warn(action);
      yield* reporter.heal({ action });
    }
  }
});

export const heal = Effect.fnUntraced(function* () {
  const reporter = yield* Reporter;
  const settings = (yield* Settings.load()).heal ?? {};
  const healing = yield* reporter.healing();
  const { heal: record, run, log, precedents } = healing;

  yield* RunLog.info(`Healing ${run.job} run ${run.id}: ${run.error ?? ""}`);

  const chosen: Chosen = yield* Option.match(
    Option.fromNullishOr(settings.decisions),
    {
      onNone: () => Effect.succeed(fallback(run)),
      onSome: Effect.fnUntraced(function* (model) {
        const limit =
          settings.decisionsPerDay ??
          (model.provider === "opencode" ? 300 : Infinity);

        const now = yield* Clock.currentTimeMillis;

        const used = (yield* reporter.heals(
          now - Duration.toMillis("1 day"),
        )).filter(({ heal }) => heal?.reason?.includes(by(model))).length;

        if (used >= limit) {
          yield* RunLog.info(
            `Not asking the decision model: it's chosen ${used} heals today, the limit`,
          );

          return fallback(
            run,
            `the decision model reached its ${limit} heals today`,
          );
        }

        const failure = describe(record, run, log, precedents);
        const agents = settings.agents ?? [];

        const orFallback = <R>(choosing: Effect.Effect<Chosen, unknown, R>) =>
          choosing.pipe(
            Effect.catchCause((cause) =>
              RunLog.warn(
                `The decision model couldn't choose: ${Cause.pretty(cause).split("\n")[0] ?? ""}`,
              ).pipe(
                Effect.as(fallback(run, "the decision model couldn't choose")),
              ),
            ),
          );

        if (model.provider === "opencode")
          return yield* orFallback(
            decideByAgent(
              failure,
              agents,
              model,
              settings.opencode ?? "opencode2",
            ),
          );

        return yield* orFallback(
          decide(failure, agents, model).pipe(
            Effect.provide(decisionLayer(model)),
          ),
        );
      }),
    },
  );

  yield* RunLog.info(`Chose to ${chosen.decision}: ${chosen.reason}`);

  yield* reporter.heal({
    decision: chosen.decision,
    reason: chosen.reason,
    ...Option.match(chosen.agent, {
      onNone: () => ({}),
      onSome: (agent) =>
        agent.variant === undefined
          ? { model: agent.model }
          : { model: agent.model, variant: agent.variant },
    }),
  });

  yield* act(healing, chosen, settings.agents ?? []);
});
