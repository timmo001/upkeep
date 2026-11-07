/**
 * GitHub's events, pulled from the Cloudflare Queue the events Worker fills.
 * The server pulls a batch every few seconds and acks it once each delivery
 * is recorded, so a restart between pulling and recording loses nothing: an
 * unacked message comes back after its visibility timeout. Without the
 * queue's account, ID and token, it does nothing and the schedules carry on.
 */
import { Domain } from "@upkeep/api";
import {
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

/** The most messages one pull takes; Cloudflare's limit is 100. */
const batchSize = 50;

/** How long a pulled message waits for its ack before it comes back. */
const visibilityTimeoutMs = 60_000;

/** One pulled message: its lease, and the event if it decoded. */
export interface Pulled {
  readonly lease: string;
  readonly event: Option.Option<Domain.GitHubEvent>;
}

const PullResponse = Schema.Struct({
  result: Schema.Struct({
    messages: Schema.Array(
      Schema.Struct({ body: Schema.String, lease_id: Schema.String }),
    ),
  }),
});

const decodeEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(Domain.GitHubEvent),
);

export class Events extends Context.Service<
  Events,
  {
    /** Whether a queue is set up; without one, nothing is pulled. */
    readonly enabled: boolean;
    /** A batch of messages, or none when the queue is empty. */
    readonly pull: () => Effect.Effect<ReadonlyArray<Pulled>, unknown>;
    /** Ack messages by their leases, so they aren't delivered again. */
    readonly ack: (
      leases: ReadonlyArray<string>,
    ) => Effect.Effect<void, unknown>;
  }
>()("@upkeep/server/Events") {
  static readonly none = Layer.succeed(
    Events,
    Events.of({
      enabled: false,
      pull: () => Effect.succeed([]),
      ack: () => Effect.void,
    }),
  );

  /**
   * The queue `$UPKEEP_EVENTS_QUEUE_ID` in the Cloudflare account
   * `$UPKEEP_EVENTS_ACCOUNT_ID`, read with the API token in
   * `$UPKEEP_EVENTS_TOKEN`, which needs Queues read and write.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const settings = yield* Config.all({
        account: Config.String("UPKEEP_EVENTS_ACCOUNT_ID"),
        queue: Config.String("UPKEEP_EVENTS_QUEUE_ID"),
        token: Config.Redacted("UPKEEP_EVENTS_TOKEN"),
      }).pipe(Config.option);

      if (Option.isNone(settings)) return Events.none;

      yield* Effect.logInfo("Pulling GitHub events from the Cloudflare Queue");

      return Layer.effect(Events, make(settings.value));
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

const make = Effect.fnUntraced(function* (options: {
  readonly account: string;
  readonly queue: string;
  readonly token: Redacted.Redacted;
}) {
  const http = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl(
          `https://api.cloudflare.com/client/v4/accounts/${options.account}/queues/${options.queue}/messages`,
        ),
        HttpClientRequest.bearerToken(options.token),
      ),
    ),
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({
      schedule: Schedule.exponential("500 millis"),
      times: 3,
    }),
  );

  return Events.of({
    enabled: true,
    pull: () =>
      http
        .execute(
          HttpClientRequest.post("/pull").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              batch_size: batchSize,
              visibility_timeout_ms: visibilityTimeoutMs,
            }),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(PullResponse)),
          Effect.map(({ result }) =>
            result.messages.map((message) => ({
              lease: message.lease_id,
              event: decodeEvent(message.body),
            })),
          ),
        ),
    ack: (leases) =>
      leases.length === 0
        ? Effect.void
        : http
            .execute(
              HttpClientRequest.post("/ack").pipe(
                HttpClientRequest.bodyJsonUnsafe({
                  acks: leases.map((lease) => ({ lease_id: lease })),
                  retries: [],
                }),
              ),
            )
            .pipe(Effect.asVoid),
  });
});
