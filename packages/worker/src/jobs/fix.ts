/**
 * A heal's fix: check out the target, create an OpenCode session with the
 * chosen model and variant through OpenCode's API, checking both, and open it
 * in a new Herdr pane to work on the failed run. The agent has the session
 * limit to finish; whatever it pushed is recorded as the heal's commit.
 */
import { Api } from "@timmo001/effect-gh";
import { herdrSdkLayer, HerdrSdk, type PaneId } from "@timmo001/effect-herdr";
import type { Domain } from "@upkeep/api";
import { Config, Effect, FileSystem, Option, Schema } from "effect";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { checkout, run } from "./bump";

class FixFailed extends Schema.TaggedError<FixFailed>()("FixFailed", {
  message: Schema.String,
}) {}

const RepositoryInfo = Schema.Struct({ default_branch: Schema.String });

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

const cacheRoot = Config.String("XDG_CACHE_HOME").pipe(
  Config.orElse(() =>
    Config.String("HOME").pipe(Config.map((home) => `${home}/.cache`)),
  ),
  Config.map((root) => `${root}/upkeep/heal`),
);

/** What the agent is told: the failure, how it went before, and how far it may go. */
const prompt = (
  heal: Domain.Heal,
  run: Domain.Run,
  log: ReadonlyArray<Domain.LogLine>,
  precedents: ReadonlyArray<Domain.Precedent>,
  repo: string,
  minutes: number,
) => {
  const reach =
    heal.target.kind === "upkeep"
      ? [
          `You may run the job again, restart the Upkeep worker, push a fix to ${repo} once \`mise run check\` passes, and restart or update the Upkeep server, when the change is self-contained and Upkeep restarts cleanly.`,
          "On the Home Assistant box, use ha-bridge first, adding what's missing, before SSH.",
        ]
      : [
          `You may push a fix straight to ${repo}'s default branch once its own checks pass. Never open a pull request.`,
        ];

  return [
    `Upkeep's ${run.job} run ${run.id} failed${heal.target.kind === "consumer" ? ` for ${repo}` : ""}:`,
    "",
    run.error ?? "(no error)",
    "",
    "The end of its log:",
    "",
    ...log.slice(-60).map((line) => `${line.level}: ${line.message}`),
    "",
    ...(precedents.length === 0
      ? []
      : [
          "The same or similar failures before, with triage's notes on them:",
          "",
          ...precedents.flatMap((precedent) => [
            `- ${precedent.title} (${precedent.state})`,
            ...precedent.notes.map(
              (note) => `  ${note.replaceAll("\n", "\n  ")}`,
            ),
          ]),
          "",
        ]),
    `Find the cause and fix it in this checkout of ${repo}.`,
    ...(run.job === "stalled-updates"
      ? [
          "The run was taking over the dependency update pull request named in the log. Apply its update here, migrate whatever the new version needs until the checks pass, push it, then close the pull request with a comment linking the commit.",
        ]
      : []),
    ...reach,
    "Anything else, or anything you aren't sure of, is for a person: stop and say what you found and what you'd do.",
    `You have ${minutes} minutes. End with a short summary of what you did.`,
  ].join("\n");
};

/** Check the model and variant are available here, as dot's Herdr launcher does. */
const resolveModel = Effect.fnUntraced(function* (
  opencode: string,
  agent: Settings.Agent,
  options: { readonly cwd: string; readonly trusted: string },
) {
  const listed = (yield* run(opencode, ["models"], options))
    .split("\n")
    .map((line) => line.trim());

  if (!listed.includes(agent.model))
    return yield* new FixFailed({
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
      return yield* new FixFailed({
        message: `${agent.model} has no variant ${agent.variant}`,
      });
  }

  return { id, providerID, variant: agent.variant };
});

/** Create the session with its model set, and check OpenCode kept both. */
const createSession = Effect.fnUntraced(function* (
  opencode: string,
  agent: Settings.Agent,
  options: { readonly cwd: string; readonly trusted: string },
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
    return yield* new FixFailed({
      message: "OpenCode created the session in another directory",
    });

  if (
    session.data.model?.id !== model.id ||
    session.data.model.providerID !== model.providerID ||
    session.data.model.variant !== model.variant
  )
    return yield* new FixFailed({
      message: "OpenCode didn't select the model and variant asked for",
    });

  return session.data.id;
});

/** Open the session in a new Herdr workspace and give it the prompt. */
const openPane = Effect.fnUntraced(function* (
  command: string,
  directory: string,
  label: string,
  text: string,
) {
  const herdr = yield* HerdrSdk;

  const opened = yield* herdr.workspaces.createInDirectory(directory, {
    label,
    focus: false,
  });

  const paneId: PaneId = opened.rootPane.id;

  yield* herdr.panes.sendInput(paneId, { text: command, keys: ["enter"] });

  const agent = yield* herdr.agents
    .wait({ paneId }, { until: ["idle", "done"], timeoutMs: 60_000 })
    .pipe(
      Effect.retry({ times: 30 }),
      Effect.timeout("90 seconds"),
      Effect.mapError(
        () => new FixFailed({ message: "OpenCode didn't start in Herdr" }),
      ),
    );

  if (Option.getOrUndefined(agent.agent) !== "opencode")
    return yield* new FixFailed({
      message: "Herdr didn't see OpenCode start in the pane",
    });

  yield* herdr.agents.prompt({ paneId }, { text });

  return paneId;
});

/** Wait for the agent to finish, or to need a person. */
const finished = Effect.fnUntraced(function* (paneId: PaneId) {
  const herdr = yield* HerdrSdk;
  let worked = false;

  for (;;) {
    yield* Effect.sleep("15 seconds");

    const { status } = yield* herdr.agents.get({ paneId });

    if (status === "working") worked = true;
    else if (status === "blocked") return "blocked" as const;
    else if (status === "done" || (worked && status === "idle"))
      return "done" as const;
  }
});

/** The tip of a remote branch. */
const tip = (
  branch: string,
  options: { readonly cwd: string; readonly trusted: string },
) =>
  run("git", ["ls-remote", "origin", `refs/heads/${branch}`], options).pipe(
    Effect.map((output) => output.split("\t")[0]?.trim() ?? ""),
  );

/**
 * Hand a fix to an agent. Returns what happened, for the heal's record, and
 * records the session and any commit as it goes.
 */
export const fix = Effect.fnUntraced(function* (
  heal: Domain.Heal,
  failed: Domain.Run,
  log: ReadonlyArray<Domain.LogLine>,
  precedents: ReadonlyArray<Domain.Precedent>,
  agent: Settings.Agent,
  record: (update: {
    readonly session?: string;
    readonly commit?: string;
  }) => Effect.Effect<void, unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  const settings = (yield* Settings.load()).heal ?? {};
  const opencode = settings.opencode ?? "opencode2";
  const minutes = settings.sessionMinutes ?? 30;
  const root = yield* cacheRoot;

  const repo =
    heal.target.kind === "consumer"
      ? heal.target.repo
      : (settings.repo ?? "timmo001/upkeep");

  const { default_branch: branch } = yield* Api.json(
    { endpoint: `repos/${repo}`, method: "GET" },
    RepositoryInfo,
  );

  const directory = `${root}/${repo}`;
  const options = { cwd: directory, trusted: root };

  yield* fs.makeDirectory(root, { recursive: true });
  yield* checkout(repo, branch, directory, root);

  const before = yield* tip(branch, options);
  const session = yield* createSession(opencode, agent, options);

  yield* record({ session });
  yield* RunLog.info(`Created OpenCode session ${session} in ${directory}`);

  const outcome = yield* Effect.gen(function* () {
    const paneId = yield* openPane(
      `${opencode} --session ${session}`,
      directory,
      `heal ${failed.job}`,
      prompt(heal, failed, log, precedents, repo, minutes),
    );

    yield* RunLog.info(`Opened it in Herdr pane ${paneId}`);

    return yield* finished(paneId).pipe(
      Effect.timeoutOption(`${minutes} minutes`),
      Effect.map(Option.getOrElse(() => "timeout" as const)),
    );
  }).pipe(Effect.provide(herdrSdkLayer));

  const after = yield* tip(branch, options);

  if (after !== "" && after !== before) yield* record({ commit: after });

  const pushed = after !== before ? `, and pushed ${after.slice(0, 7)}` : "";

  switch (outcome) {
    case "done":
      return `The agent finished${pushed}`;
    case "blocked":
      return `The agent needs a person${pushed}`;
    case "timeout":
      return `The agent ran out of its ${minutes} minutes${pushed}; its session is left open`;
  }
});
