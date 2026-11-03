/**
 * Upkeep's memory of failures, kept in triage: each failure that's healed is
 * sent as an event, so the same failure groups into one issue; a heal reads
 * the notes on it and on similar issues, a fix resolves it with a note, and
 * resolving it unparks its job. Without triage's URL and tokens, it does
 * nothing.
 */
import { Api as TriageApi, Event, Fingerprint } from "@timmo001/effect-triage";
import type { Domain } from "@upkeep/api";
import {
  Clock,
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schedule,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
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
   * admin token in `$UPKEEP_TRIAGE_ADMIN_TOKEN`.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const settings = yield* Config.all({
        url: Config.String("UPKEEP_TRIAGE_URL"),
        host: Config.Redacted("UPKEEP_TRIAGE_HOST_TOKEN"),
        admin: Config.Redacted("UPKEEP_TRIAGE_ADMIN_TOKEN"),
      }).pipe(Config.option);

      return Option.match(settings, {
        onNone: () => Triage.none,
        onSome: (options) =>
          Layer.effect(Triage, make(options)).pipe(
            Layer.provide(FetchHttpClient.layer),
          ),
      });
    }),
  );
}

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
  target.kind === "upkeep" ? "upkeep" : target.repo;

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
