/**
 * The heal job: read a failed or lost run and its log, and choose what to do
 * with a decision model, or an LLM through OpenCode: run it again, hand a fix
 * to an agent in a headless OpenCode session, park the job, or leave it for
 * you on the dashboard and the Attention page. Whatever it chooses goes in
 * the heal's record. Without a decision model in the settings, a lost run is
 * retried and anything else is left for you.
 */
import {
  CloudflareClient,
  CloudflareDecisionModel,
} from "@effect/ai-cloudflare";
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import {
  GhCommandError,
  GhTimeoutError,
  isRateLimited,
  isTransient,
} from "@timmo001/effect-gh";
import { Catalogue, Domain } from "@upkeep/api";
import { tmpdir } from "node:os";
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
import { reason as failureReason } from "../Failure";
import * as RateLimits from "../RateLimits";
import { attention, Reporter, summary, type Healing } from "../Reporter";
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
 * The log lines about the heal's target: for consumers, the ones naming their
 * repositories, so a run over many repositories reads as their failure.
 * Anything else, or consumers the log never names, gets the whole tail.
 */
export const relevant = (
  heal: Domain.Heal,
  log: ReadonlyArray<Domain.LogLine>,
) => {
  const repos = Domain.targetRepos(heal.target);

  if (repos.length === 0) return log;

  const about = log.filter(({ message }) =>
    repos.some(
      (repo) =>
        message.startsWith(`${repo}:`) || message.startsWith(`${repo}#`),
    ),
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
    target:
      heal.target.kind === "upkeep"
        ? "upkeep"
        : Domain.targetRepos(heal.target).join(", "),
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

/**
 * A drift review fails on purpose to hand its list to an agent, so there's
 * nothing for a decision model to choose: it goes to the last agent, the one
 * for hard fixes, or is left for you without one.
 */
const reviewing = (agents: ReadonlyArray<Settings.Agent>): Chosen =>
  Option.match(Option.fromNullishOr(agents.at(-1)), {
    onNone: () => ({
      decision: "ask",
      reason: "A drift review is for an agent, and there's none set up",
      agent: Option.none(),
      decided: false,
    }),
    onSome: (agent) => ({
      decision: "fix",
      reason: "A drift review always goes to an agent",
      agent: Option.some(agent),
      decided: false,
    }),
  });

/** How a heal's reason names the model that chose it, to count its use. */
const by = (model: Settings.DecisionModel) =>
  `by ${Settings.deciderName(model)}`;

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

/** How many times a heal starts its agent again after a temporary failure. */
const startRetries = 3;

const isGh = (error: unknown): error is GhCommandError | GhTimeoutError =>
  error instanceof GhCommandError || error instanceof GhTimeoutError;

/**
 * Whether gh failed in a way waiting can get past. One that printed nothing
 * was most likely stopped or cut off, as in a GitHub or network outage.
 */
const ghTransient = (error: GhCommandError | GhTimeoutError) =>
  isTransient(error) ||
  (error instanceof GhCommandError &&
    error.stderr.trim() === "" &&
    error.stdout.trim() === "");

/** Whether a run failed on a gh command, from its error's first line. */
const failedOnGh = (run: Domain.Run) =>
  /^Gh(Command|Timeout)Error\b/.test(run.error ?? "");

/**
 * How long to wait before starting the agent again: until GitHub's rate limit
 * resets, or a backoff of a minute, then two, then four, for a network error
 * or a GitHub outage. None for a failure waiting won't fix.
 */
const startDelay = Effect.fnUntraced(function* (
  cause: Cause.Cause<unknown>,
  attempt: number,
) {
  const error = Cause.squash(cause);

  if (!isGh(error) || !ghTransient(error))
    return Option.none<Duration.Duration>();

  const backoff = Duration.minutes(2 ** attempt);

  if (!isRateLimited(error)) return Option.some(backoff);

  const reset = yield* RateLimits.spentUntil();
  const now = yield* Clock.currentTimeMillis;

  // A secondary rate limit has no reset to wait for, only a backoff.
  return Option.some(
    Option.match(reset, {
      onNone: () => backoff,
      onSome: (time) => RateLimits.waitUntil(time, now),
    }),
  );
});

/**
 * Hand a fix to an agent. One that leaves it unfixed marks the run as needing
 * you, with the session in its heal's record. An agent that couldn't
 * start after a temporary failure, such as GitHub's rate limit, starts again
 * once it's passed; one that still can't is left for you, unless gh failed
 * for the run too, when the job runs again.
 */
const handOff = Effect.fnUntraced(function* (
  healing: Healing,
  agent: Settings.Agent,
) {
  const reporter = yield* Reporter;
  const { run } = healing;

  // Once there's a session the agent has started, so it isn't started again.
  let started = false;

  const start = (
    attempt: number,
  ): Effect.Effect<
    Effect.Success<ReturnType<typeof fix>>,
    unknown,
    Effect.Services<ReturnType<typeof fix>>
  > =>
    fix(
      healing.heal,
      run,
      relevant(healing.heal, healing.log),
      healing.precedents,
      agent,
      (update) => {
        if (update.session !== undefined) started = true;

        return reporter.heal(update);
      },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const delay =
            started || attempt >= startRetries
              ? Option.none<Duration.Duration>()
              : yield* startDelay(cause, attempt);

          if (Option.isNone(delay)) return yield* Effect.failCause(cause);

          yield* RunLog.warn(
            `The agent couldn't start, ${failureReason(cause)}. Trying again in ${Duration.format(delay.value)}`,
          );
          yield* Effect.sleep(delay.value);

          return yield* start(attempt + 1);
        }),
      ),
    );

  const result = yield* start(0).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        // gh failing for the run and for the agent too looks like an outage,
        // not something an agent can fix, so the job runs again instead.
        if (!started && isGh(Cause.squash(cause)) && failedOnGh(run)) {
          const queued = yield* reporter.retry();

          return {
            action:
              queued === null
                ? `Didn't queue ${run.job} again: it's parked. gh failed for the agent's start too, ${failureReason(cause)}`
                : `Queued ${run.job} again as ${queued.id}: gh failed for the agent's start too, ${failureReason(cause)}, which looks like an outage`,
            session: null,
            directory: null,
            attention: false,
            said: null,
          };
        }

        return {
          action: `Left for you: the agent couldn't start, ${failureReason(cause)}`,
          session: null,
          directory: null,
          attention: true,
          said: null,
        };
      }),
    ),
  );

  yield* RunLog.info(result.action);
  yield* reporter.heal({ action: result.action });
  yield* summary(
    result.said === null
      ? result.action
      : `${result.action}.\n\n${result.said}`,
  );

  if (!result.attention) return;

  yield* attention;

  if (result.session === null || result.directory === null) return;

  const { session, directory } = result;
  const settings = (yield* Settings.load()).heal ?? {};

  // A session over several consumers is shared under the first of them
  const repo =
    Domain.targetRepos(healing.heal.target)[0] ??
    settings.repo ??
    "timmo001/upkeep";

  // Another worker can only open the session from a copy on the server
  yield* exec(
    settings.opencode ?? "opencode2",
    ["session", "export", session],
    {
      cwd: directory,
      trusted: "",
    },
  ).pipe(
    Effect.flatMap((exported) =>
      reporter.shareSession({ repo, export: exported }),
    ),
    Effect.andThen(RunLog.info(`Shared session ${session} with the server`)),
    Effect.catchCause((cause) =>
      RunLog.warn(`Couldn't share the session: ${failureReason(cause)}`),
    ),
  );

  if (settings.handOff !== undefined) {
    const target = Domain.targetName(healing.heal.target);

    const fill = (arg: string) =>
      arg
        .replaceAll("{session}", session)
        .replaceAll("{directory}", directory)
        .replaceAll("{name}", directory.split("/").at(-1) ?? directory)
        .replaceAll("{title}", `${run.job} heal for ${target}`);

    const [program = "", ...args] = settings.handOff.command.map(fill);

    yield* exec(program, args, { cwd: directory, trusted: "" }).pipe(
      Effect.andThen(RunLog.info(`Handed session ${session} off`)),
      Effect.andThen(reporter.heal({ action: "Handed its session off" })),
      Effect.catchCause((cause) =>
        RunLog.warn(`Couldn't hand the session off: ${failureReason(cause)}`),
      ),
    );
  }
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

      yield* summary(action);
      yield* reporter.heal({ action });

      return;
    }

    case "park": {
      yield* reporter.park(run.job, chosen.reason, healing.heal.issue);

      const action = `Parked ${run.job}`;

      yield* RunLog.warn(action);
      yield* reporter.heal({ action });
      yield* reporter.report({ summary: `${action}: ${chosen.reason}` });
      yield* attention;

      return;
    }

    case "fix": {
      if (Option.isNone(chosen.agent)) {
        const action = "Left for you: there's no agent to fix it";

        yield* RunLog.warn(action);
        yield* reporter.heal({ action });
        yield* reporter.report({ summary: action });
        yield* attention;

        return;
      }

      return yield* handOff(healing, chosen.agent.value);
    }

    case "ask": {
      // The model isn't sure what's wrong, which is what the last agent, the
      // one for hard fixes, is for. Without one, or a model, it's left for
      // you.
      const agent = agents.at(-1);

      if (chosen.decided && agent !== undefined)
        return yield* handOff(healing, agent);

      const action = "Left for you";

      yield* RunLog.warn(action);
      yield* reporter.heal({ action });
      yield* reporter.report({ summary: `${action}: ${chosen.reason}` });
      yield* attention;
    }
  }
});

export const heal = Effect.fnUntraced(function* () {
  const reporter = yield* Reporter;
  const settings = (yield* Settings.load()).heal ?? {};
  const healing = yield* reporter.healing();
  const { heal: record, run, log, precedents } = healing;

  yield* RunLog.info(`Healing ${run.job} run ${run.id}: ${run.error ?? ""}`);

  const chosen: Chosen =
    run.job === Catalogue.driftReview.id
      ? reviewing(settings.agents ?? [])
      : yield* Option.match(Option.fromNullishOr(settings.decisions), {
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

            const orFallback = <R>(
              choosing: Effect.Effect<Chosen, unknown, R>,
            ) =>
              choosing.pipe(
                Effect.catchCause((cause) =>
                  RunLog.warn(
                    `The decision model couldn't choose: ${failureReason(cause)}`,
                  ).pipe(
                    Effect.as(
                      fallback(run, "the decision model couldn't choose"),
                    ),
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
        });

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

  if (chosen.decided && settings.decisions !== undefined)
    yield* reporter.heal({
      decidedBy: Settings.deciderName(settings.decisions),
    });

  yield* act(healing, chosen, settings.agents ?? []);
});
