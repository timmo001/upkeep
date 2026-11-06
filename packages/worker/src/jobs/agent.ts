/**
 * Running an OpenCode agent headless: check the model and variant are there,
 * create a session with them, and read what the agent said last. Heal's fixes
 * and held skill changes start their agents the same way.
 */
import { Api } from "@timmo001/effect-gh";
import { Effect, Schema } from "effect";
import { pushed } from "../Reporter";
import type * as Settings from "../settings";
import { run } from "./bump";

export class AgentFailed extends Schema.TaggedError<AgentFailed>()(
  "AgentFailed",
  { message: Schema.String },
) {}

type Options = { readonly cwd: string; readonly trusted: string };

const Session = Schema.Struct({
  data: Schema.Struct({
    id: Schema.String.check(Schema.isPattern(/^ses[\w-]+$/)),
    location: Schema.Struct({ directory: Schema.String }),
    model: Schema.optionalKey(
      Schema.Struct({
        id: Schema.String,
        providerID: Schema.String,
        variant: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
});

const Catalogue = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      providerID: Schema.String,
      variants: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  ),
});

/** An agent's model and variant, without what it's for. */
export type Model = Pick<Settings.Agent, "model" | "variant">;

/** Check the model and variant are available here, as dot's Herdr launcher does. */
const resolveModel = Effect.fnUntraced(function* (
  opencode: string,
  agent: Model,
  options: Options,
) {
  const listed = (yield* run(opencode, ["models"], options))
    .split("\n")
    .map((line) => line.trim());

  if (!listed.includes(agent.model))
    return yield* new AgentFailed({
      message: `OpenCode has no model ${agent.model}`,
    });

  const slash = agent.model.indexOf("/");
  const providerID = agent.model.slice(0, slash);
  const id = agent.model.slice(slash + 1);

  if (agent.variant !== undefined) {
    const catalogue = yield* run(
      opencode,
      [
        "api",
        "get",
        `/api/model?location%5Bdirectory%5D=${encodeURIComponent(options.cwd)}`,
      ],
      options,
    ).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Catalogue)),
      ),
    );

    const model = catalogue.data.find(
      (entry) => entry.id === id && entry.providerID === providerID,
    );

    if (!model?.variants.some((entry) => entry.id === agent.variant))
      return yield* new AgentFailed({
        message: `${agent.model} has no variant ${agent.variant}`,
      });
  }

  return { id, providerID, variant: agent.variant };
});

/** Create the session with its model set, and check OpenCode kept both. */
export const createSession = Effect.fnUntraced(function* (
  opencode: string,
  agent: Model,
  options: Options,
) {
  const model = yield* resolveModel(opencode, agent, options);

  const session = yield* run(
    opencode,
    [
      "api",
      "post",
      "/api/session",
      "--data",
      JSON.stringify({ location: { directory: options.cwd }, model }),
    ],
    options,
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Session))),
  );

  if (session.data.location.directory !== options.cwd)
    return yield* new AgentFailed({
      message: "OpenCode created the session in another directory",
    });

  if (
    session.data.model?.id !== model.id ||
    session.data.model.providerID !== model.providerID ||
    session.data.model.variant !== model.variant
  )
    return yield* new AgentFailed({
      message: "OpenCode didn't select the model and variant asked for",
    });

  return session.data.id;
});

const Comparison = Schema.Struct({
  commits: Schema.Array(
    Schema.Struct({
      sha: Schema.String,
      commit: Schema.Struct({ message: Schema.String }),
    }),
  ),
});

/** Record each commit pushed between two tips as the run's changes. */
export const recordCommits = Effect.fnUntraced(function* (
  repo: string,
  before: string,
  after: string,
) {
  const { commits } = yield* Api.json(
    { endpoint: `repos/${repo}/compare/${before}...${after}`, method: "GET" },
    Comparison,
  ).pipe(Effect.orElseSucceed(() => ({ commits: [] })));

  for (const { sha, commit } of commits)
    yield* pushed(repo, sha, commit.message.split("\n")[0] ?? "");
});

const Messages = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      time: Schema.Struct({ created: Schema.Finite }),
      content: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            type: Schema.String,
            text: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
    }),
  ),
});

/** What the agent said last, which its prompt asks to be its summary. */
export const lastWords = Effect.fnUntraced(function* (
  opencode: string,
  session: string,
  options: Options,
) {
  const { data } = yield* run(
    opencode,
    ["api", "get", `/api/session/${session}/message`],
    options,
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Messages))),
  );

  const texts = data
    .filter((message) => message.type === "assistant")
    .toSorted((a, b) => b.time.created - a.time.created)
    .map((message) =>
      (message.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("")
        .trim(),
    );

  const text = texts.find((said) => said !== "");

  return text === undefined ? null : text.slice(0, 4000);
});
