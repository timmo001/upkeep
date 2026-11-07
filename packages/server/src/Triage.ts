/**
 * Upkeep's memory of failures, kept in triage: each failure that's healed is
 * sent as an event, so the same failure groups into one issue; a heal reads
 * the notes on it and on similar issues, a fix resolves it with a note, and
 * resolving it unparks its job. Without triage's URL and tokens, it does
 * nothing.
 */
import { Api as TriageApi, Event, Fingerprint } from "@timmo001/effect-triage";
import { Domain } from "@upkeep/api";
import {
  Clock,
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api";

/** How many precedents a heal reads. */
const maxPrecedents = 5;

/** The longest note text a precedent carries. */
const maxNote = 1000;

export class Triage extends Context.Service<
  Triage,
  {
    /**
     * Send a failed run as an event for its target, returning the ID of the
     * triage issue it belongs to.
     */
    readonly report: (
      run: Domain.Run,
      target: Domain.Target,
    ) => Effect.Effect<Option.Option<string>>;
    /** What triage knows of an issue and those like it, with their notes. */
    readonly precedents: (
      issue: string,
    ) => Effect.Effect<ReadonlyArray<Domain.Precedent>>;
    /** Resolve an issue with a note on what fixed it. */
    readonly resolve: (issue: string, note: string) => Effect.Effect<void>;
    /** Whether an issue has been resolved. */
    readonly resolved: (issue: string) => Effect.Effect<boolean>;
  }
>()("@upkeep/server/Triage") {
  static readonly none = Layer.succeed(
    Triage,
    Triage.of({
      report: () => Effect.succeed(Option.none()),
      precedents: () => Effect.succeed([]),
      resolve: () => Effect.void,
      resolved: () => Effect.succeed(false),
    }),
  );

  /**
   * Triage at `$UPKEEP_TRIAGE_URL`, sending events with the host token in
   * `$UPKEEP_TRIAGE_HOST_TOKEN` and reading and resolving issues with the
   * admin token in `$UPKEEP_TRIAGE_ADMIN_TOKEN`. Without a URL, the Home
   * Assistant app finds the triage app from the same repository through the
   * Supervisor.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const settings = yield* Config.all({
        url: Config.option(Config.String("UPKEEP_TRIAGE_URL")),
        host: Config.Redacted("UPKEEP_TRIAGE_HOST_TOKEN"),
        admin: Config.Redacted("UPKEEP_TRIAGE_ADMIN_TOKEN"),
      }).pipe(Config.option);

      if (Option.isNone(settings)) return Triage.none;

      const url = Option.isSome(settings.value.url)
        ? settings.value.url
        : yield* discover;

      if (Option.isNone(url)) {
        yield* Effect.logWarning(
          "Triage tokens are set, but no triage URL was set or found",
        );

        return Triage.none;
      }

      yield* Effect.logInfo(`Reporting failures to triage at ${url.value}`);

      return Layer.effect(Triage, make({ ...settings.value, url: url.value }));
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

const AppInfo = Schema.Struct({
  body: Schema.Struct({
    data: Schema.Struct({
      slug: Schema.String,
      hostname: Schema.String,
      state: Schema.String,
    }),
  }),
});

/** The port triage's API listens on inside its app. */
const triagePort = 7171;

/**
 * The URL of the triage app installed from the same repository as this app,
 * on the Supervisor's network, when it's running. Nothing outside the Home
 * Assistant app, which has `$SUPERVISOR_TOKEN`.
 */
const discover = Effect.gen(function* () {
  const token = yield* Config.option(Config.Redacted("SUPERVISOR_TOKEN"));

  if (Option.isNone(token)) return Option.none<string>();

  const http = yield* HttpClient.HttpClient;

  const info = (slug: string) =>
    http
      .get(`http://supervisor/addons/${slug}/info`, {
        headers: { authorization: `Bearer ${Redacted.value(token.value)}` },
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaJson(AppInfo)),
        Effect.map((response) => response.body.data),
      );

  const self = yield* info("self");
  const repository = self.slug.split("_")[0];
  const triage = yield* info(`${repository}_triage`);

  return triage.state === "started"
    ? Option.some(`http://${triage.hostname}:${triagePort}`)
    : Option.none<string>();
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Couldn't find the triage app", cause).pipe(
      Effect.as(Option.none<string>()),
    ),
  ),
);

const client = (url: string, token: Redacted.Redacted) => {
  const bearer: HttpApiMiddleware.HttpApiMiddlewareClient<
    never,
    never,
    never
  > = ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, token));

  return HttpApiClient.make(TriageApi.Api, {
    transformClient: (http) =>
      http.pipe(
        HttpClient.mapRequest(
          HttpClientRequest.prependUrl(url.replace(/\/+$/, "")),
        ),
        HttpClient.retryTransient({
          schedule: Schedule.exponential("200 millis"),
          times: 3,
        }),
      ),
  }).pipe(
    Effect.provide([
      HttpApiMiddleware.layerClient(TriageApi.HostAuthorization, bearer),
      HttpApiMiddleware.layerClient(TriageApi.AdminAuthorization, bearer),
      HttpApiMiddleware.layerClient(TriageApi.WorkerAuthorization, bearer),
    ]),
  );
};

const targetName = (target: Domain.Target) =>
  target.kind === "upkeep" ? "upkeep" : Domain.targetRepos(target).join(",");

const make = Effect.fnUntraced(function* (options: {
  readonly url: string;
  readonly host: Redacted.Redacted;
  readonly admin: Redacted.Redacted;
}) {
  const host = yield* client(options.url, options.host);
  const admin = yield* client(options.url, options.admin);

  const report = Effect.fnUntraced(
    function* (run: Domain.Run, target: Domain.Target) {
      const firstLine = (run.error ?? "failed").split("\n")[0] ?? "failed";

      const event = Event.Event.cases.LogError.make({
        id: `${run.id}-${targetName(target)}`,
        host: "upkeep",
        source: "upkeep",
        timestamp: run.finishedAt ?? (yield* Clock.currentTimeMillis),
        severity: "err",
        identifier: `upkeep-${run.job}`,
        message: `${targetName(target)}: ${firstLine}`,
      });

      yield* host.ingest.events({ payload: { events: [event] } });

      return Option.some(Fingerprint.issueId(Fingerprint.fingerprint(event)));
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Couldn't report a failure to triage", cause).pipe(
        Effect.as(Option.none<string>()),
      ),
    ),
  );

  const notesOf = (notes: ReadonlyArray<TriageApi.IssueNote>) =>
    notes.flatMap((note) =>
      note.text === "" ? [] : [note.text.slice(0, maxNote)],
    );

  const precedents = Effect.fnUntraced(
    function* (issue: string) {
      const params = { id: issue };
      const review = yield* admin.issues.get({ params });

      const similar = yield* admin.issues.similar({
        params,
        query: { limit: maxPrecedents },
      });

      return [
        {
          title: review.issue.title,
          state: review.issue.state,
          notes: notesOf(review.notes),
        },
        ...similar.map((entry) => ({
          title: entry.title,
          state: entry.state,
          notes: notesOf(entry.notes),
        })),
      ]
        .filter((entry) => entry.notes.length > 0)
        .slice(0, maxPrecedents);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Couldn't read precedents from triage", cause).pipe(
        Effect.as<ReadonlyArray<Domain.Precedent>>([]),
      ),
    ),
  );

  const resolve = (issue: string, note: string) =>
    admin.issues
      .setStatus({
        params: { id: issue },
        payload: { status: "resolved", note: note.slice(0, 10_000) },
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Couldn't resolve a triage issue", cause),
        ),
      );

  const resolved = (issue: string) =>
    admin.issues.get({ params: { id: issue } }).pipe(
      Effect.map((review) => review.issue.state === "resolved"),
      Effect.catchCause((cause) =>
        Effect.logWarning("Couldn't read a triage issue", cause).pipe(
          Effect.as(false),
        ),
      ),
    );

  return Triage.of({ report, precedents, resolve, resolved });
});
