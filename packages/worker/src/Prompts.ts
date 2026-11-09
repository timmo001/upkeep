/**
 * Watches this machine's OpenCode for agents stuck on a permission prompt.
 * Every 15 seconds the worker asks the background service, found from its
 * registration file, for the prompts waiting in each place it has loaded.
 * Once one has waited a minute, so a prompt answered at once never shows,
 * the worker tells the server, which shows it as needing you until it's
 * answered. It sends the whole set each time it changes, so a prompt answered
 * or lost to a restart clears, and a machine without OpenCode sends none.
 */
import { Client, type Domain } from "@upkeep/api";
import {
  Clock,
  Config,
  Effect,
  FileSystem,
  Option,
  Path,
  Ref,
  Schedule,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/** How long a prompt waits before it counts as needing you. */
const patience = 60_000;

/** OpenCode's registration of its background service. */
const Service = Schema.fromJsonString(
  Schema.Struct({
    url: Schema.String,
    password: Schema.optionalKey(Schema.String),
  }),
);

const Locations = Schema.Array(
  Schema.Struct({
    directory: Schema.String,
    workspaceID: Schema.optionalKey(Schema.String),
  }),
);

const Requests = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      sessionID: Schema.String,
      action: Schema.String,
      resources: Schema.Array(Schema.String),
    }),
  ),
});

const Session = Schema.Struct({
  data: Schema.Struct({ title: Schema.optionalKey(Schema.String) }),
});

/** The service's registration, in `$XDG_STATE_HOME`, by default `~/.local/state`. */
const registration = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* Config.String("HOME").pipe(Config.withDefault(""));

  const stateHome = yield* Config.String("XDG_STATE_HOME").pipe(
    Config.withDefault(path.join(home, ".local", "state")),
  );

  return yield* fs
    .readFileString(path.join(stateHome, "opencode", "service.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Service)), Effect.option);
});

/**
 * The prompts that have waited past `patience`, given when each was first
 * seen, which is kept to the ones still waiting. None when OpenCode isn't
 * running here.
 */
const waiting = Effect.fnUntraced(function* (
  seen: Ref.Ref<ReadonlyMap<string, number>>,
) {
  const service = yield* registration;

  if (Option.isNone(service)) {
    yield* Ref.set(seen, new Map());

    return [];
  }

  const { url, password } = service.value;

  const http = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) => {
      const based = HttpClientRequest.prependUrl(request, url);

      return password === undefined
        ? based
        : HttpClientRequest.basicAuth(based, "opencode", password);
    }),
    HttpClient.filterStatusOk,
  );

  const get = <S extends Schema.Constraint>(
    schema: S,
    path: string,
    params: Readonly<Record<string, string>> = {},
  ) =>
    http
      .get(path, { urlParams: params })
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)));

  // Prompts live in the places the service has loaded, each asked on its own
  const locations = yield* get(Locations, "/api/debug/location");

  const requests = (yield* Effect.forEach(
    locations,
    (location) =>
      get(Requests, "/api/permission/request", {
        "location[directory]": location.directory,
        ...(location.workspaceID !== undefined && {
          "location[workspaceID]": location.workspaceID,
        }),
      }).pipe(
        Effect.map(({ data }) =>
          data.map((request) => ({
            ...request,
            directory: location.directory,
          })),
        ),
      ),
    { concurrency: 4 },
  )).flat();

  const now = yield* Clock.currentTimeMillis;

  const firstSeen = yield* Ref.updateAndGet(
    seen,
    (before) =>
      new Map(
        requests.map((request) => [request.id, before.get(request.id) ?? now]),
      ),
  );

  return yield* Effect.forEach(
    requests.filter(
      (request) => now - (firstSeen.get(request.id) ?? now) >= patience,
    ),
    (request): Effect.Effect<Domain.PermissionPrompt> =>
      get(Session, `/api/session/${request.sessionID}`).pipe(
        Effect.map(({ data }) => data.title ?? null),
        Effect.orElseSucceed(() => null),
        Effect.map((title) => ({
          id: request.id,
          session: request.sessionID,
          title,
          directory: request.directory,
          action: request.action,
          resources: request.resources,
        })),
      ),
    { concurrency: 4 },
  );
});

/** Tell the server about the prompts left waiting, following them until the worker stops. */
export const follow = Effect.gen(function* () {
  const client = yield* Client;
  const seen = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  // The prompts the server last took, so an unchanged set isn't sent again
  const sent = yield* Ref.make(Option.none<string>());

  const check = Effect.gen(function* () {
    const prompts = yield* waiting(seen);

    const ids = prompts
      .map((prompt) => prompt.id)
      .toSorted()
      .join(",");

    if (Option.contains(yield* Ref.get(sent), ids)) return;

    yield* client.work.putPrompts({ payload: { prompts } });
    yield* Ref.set(sent, Option.some(ids));
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logDebug("Couldn't check OpenCode's permission prompts", cause),
    ),
  );

  yield* check.pipe(Effect.repeat(Schedule.spaced("15 seconds")));
});
