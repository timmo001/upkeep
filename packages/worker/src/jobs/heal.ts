/**
 * The heal job: read a failed or lost run and its log, and choose what to do
 * with a decision model: run it again, hand a fix to an agent in an OpenCode
 * session in Herdr, park the job, or ask. Whatever it chooses goes in the heal's record. Without a decision
 * model in the settings, a lost run is retried and anything else is asked.
 */
import {
  CloudflareClient,
  CloudflareDecisionModel,
} from "@effect/ai-cloudflare";
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import { Domain } from "@upkeep/api";
import { stripVTControlCharacters } from "node:util";
import { Cause, Config, Effect, Layer, Option, Schema } from "effect";
import { Decision, DecisionModel } from "effect/ai";
import * as Inbox from "../Inbox";
import { Reporter, type Healing } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
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

/** What to do with no decision model: retry a lost run, ask about the rest. */
export const fallback = (run: Domain.Run): Chosen =>
  run.error?.startsWith("Lost") === true
    ? {
        decision: "retry",
        reason: "The worker was lost, and there's no decision model",
        agent: Option.none(),
        decided: false,
      }
    : {
        decision: "ask",
        reason: "There's no decision model to choose",
        agent: Option.none(),
        decided: false,
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

/** The longest stretch of log a message to a person quotes. */
const maxQuote = 3000;

/**
 * Ask a person about a heal through the Inbox: what failed for this target,
 * in its own log lines rather than the run's summary of every failure, what
 * the heal chose and why, and what lets the job go on.
 */
const askPerson = (healing: Healing, chosen: Chosen, action: string) => {
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

  const next =
    record.issue !== null
      ? `It's issue ${record.issue} in triage: resolving it there, with a note on the fix, unparks the job and tells the next heal what worked.`
      : chosen.decision === "park"
        ? `Once it's fixed, \`upkeep unpark ${run.job}\` lets it run again.`
        : consumer
          ? `The next ${run.job} run picks ${target} up again once it's fixed there.`
          : `The next ${run.job} run tries again.`;

  return Inbox.send(
    `Upkeep: ${target} needs a look (${run.job})`,
    [
      `${run.job} failed for ${target} (run ${run.id}):`,
      "",
      "```text",
      quote,
      "```",
      "",
      `${action}: ${chosen.reason}.`,
      "",
      next,
    ].join("\n"),
    `upkeep-heal-${run.id}-${record.of}`,
  );
};

/** Carry out a choice, adding what it did to the heal's record. */
const act = Effect.fnUntraced(function* (healing: Healing, chosen: Chosen) {
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
      yield* askPerson(healing, chosen, action);

      return;
    }

    case "fix": {
      if (Option.isNone(chosen.agent)) {
        const action = "Left for a person: there's no agent to fix it";

        yield* RunLog.warn(action);
        yield* reporter.heal({ action });

        return;
      }

      const action = yield* fix(
        healing.heal,
        run,
        healing.log,
        healing.precedents,
        chosen.agent.value,
        (update) => reporter.heal(update),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            `Left for a person: the agent couldn't start, ${Cause.pretty(cause).split("\n")[0] ?? ""}`,
          ),
        ),
      );

      yield* RunLog.info(action);
      yield* reporter.heal({ action });

      return;
    }

    case "ask": {
      const action = "Left for a person to look at";

      yield* RunLog.warn(action);
      yield* reporter.heal({ action });

      // Without a decision model every failure lands here, so it waits for
      // the evening digest rather than a message of its own.
      if (chosen.decided) yield* askPerson(healing, chosen, action);
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
      onSome: (model) =>
        decide(
          describe(record, run, log, precedents),
          settings.agents ?? [],
          model,
        ).pipe(Effect.provide(decisionLayer(model))),
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

  yield* act(healing, chosen);
});
