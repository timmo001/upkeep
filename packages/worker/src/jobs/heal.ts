/**
 * The heal job: read a failed or lost run and its log, and choose what to do
 * with a decision model: run it again, hand a fix to an agent, park the job,
 * or ask. Whatever it chooses goes in the heal's record. Without a decision
 * model in the settings, a lost run is retried and anything else is asked.
 */
import {
  CloudflareClient,
  CloudflareDecisionModel,
} from "@effect/ai-cloudflare";
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import { Domain } from "@upkeep/api";
import { Config, Effect, Layer, Option, Schema } from "effect";
import { Decision, DecisionModel } from "effect/ai";
import { Reporter } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";

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
}

const label = (agent: Settings.Agent) =>
  agent.variant === undefined ? agent.model : `${agent.model}#${agent.variant}`;

const decisionLayer = (options: Settings.DecisionModel) =>
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

/** What the model reads: the run, its error and the end of its log. */
export const describe = (
  heal: Domain.Heal,
  run: Domain.Run,
  log: ReadonlyArray<Domain.LogLine>,
): Failure => ({
  failed: {
    job: run.job,
    trigger: run.trigger,
    target: heal.target.kind === "upkeep" ? "upkeep" : heal.target.repo,
    error: (run.error ?? "").slice(0, maxMessage),
    log: log
      .slice(-maxLines)
      .map((line) => `${line.level}: ${line.message.slice(0, maxMessage)}`),
  },
});

/** What to do with no decision model: retry a lost run, ask about the rest. */
export const fallback = (run: Domain.Run): Chosen =>
  run.error?.startsWith("Lost") === true
    ? {
        decision: "retry",
        reason: "The worker was lost, and there's no decision model",
        agent: Option.none(),
      }
    : {
        decision: "ask",
        reason: "There's no decision model to choose",
        agent: Option.none(),
      };

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
  const reason = `${actions[decision]} (${sure}% sure, by ${model.provider}/${model.model})`;

  if (decision !== "fix" || agents.length < 2) {
    return {
      decision,
      reason,
      agent: Option.fromNullishOr(decision === "fix" ? agents[0] : undefined),
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
  } satisfies Chosen;
});

/** Carry out a choice, adding what it did to the heal's record. */
const act = Effect.fnUntraced(function* (run: Domain.Run, chosen: Chosen) {
  const reporter = yield* Reporter;

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
      yield* reporter.park(run.job, chosen.reason);

      const action = `Parked ${run.job}`;

      yield* RunLog.warn(action);
      yield* reporter.heal({ action });

      return;
    }

    case "fix":
    case "ask": {
      const action =
        chosen.decision === "fix"
          ? "Left for a person: agent fixes aren't wired up yet"
          : "Left for a person to look at";

      yield* RunLog.warn(action);
      yield* reporter.heal({ action });
    }
  }
});

export const heal = Effect.fnUntraced(function* () {
  const reporter = yield* Reporter;
  const settings = (yield* Settings.load()).heal ?? {};
  const { heal: record, run, log } = yield* reporter.healing();

  yield* RunLog.info(`Healing ${run.job} run ${run.id}: ${run.error ?? ""}`);

  const chosen: Chosen = yield* Option.match(
    Option.fromNullishOr(settings.decisions),
    {
      onNone: () => Effect.succeed(fallback(run)),
      onSome: (model) =>
        decide(describe(record, run, log), settings.agents ?? [], model).pipe(
          Effect.provide(decisionLayer(model)),
        ),
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

  yield* act(run, chosen);
});
