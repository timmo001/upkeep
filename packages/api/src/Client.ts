/** A typed client for the Upkeep server's API, for workers and the CLI. */
import { Context, Layer, Redacted, Schedule } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api";
import * as Api from "./Api";

export interface ClientOptions {
  /** The server's base URL, such as `https://upkeep.example.com`. */
  readonly url: string;
  /** An admin token, or a worker token for a worker's endpoints. */
  readonly token: Redacted.Redacted;
}

export class Client extends Context.Service<
  Client,
  HttpApiClient.ForApi<typeof Api.Api>
>()("@upkeep/api/Client") {
  /** A client for the given server, authenticating with a token. */
  static readonly layer = (options: ClientOptions) => {
    const bearer: HttpApiMiddleware.HttpApiMiddlewareClient<
      never,
      never,
      never
    > = ({ next, request }) =>
      next(HttpClientRequest.bearerToken(request, options.token));

    return Layer.effect(
      Client,
      HttpApiClient.make(Api.Api, {
        transformClient: (client) =>
          client.pipe(
            HttpClient.mapRequest(
              HttpClientRequest.prependUrl(options.url.replace(/\/+$/, "")),
            ),
            HttpClient.retryTransient({
              schedule: Schedule.exponential("200 millis"),
              times: 3,
            }),
          ),
      }),
    ).pipe(
      Layer.provide([
        HttpApiMiddleware.layerClient(Api.AdminAuthorization, bearer),
        HttpApiMiddleware.layerClient(Api.WorkerAuthorization, bearer),
      ]),
    );
  };
}
