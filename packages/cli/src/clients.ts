/** Clients for the Upkeep server, as an admin or a worker, with tokens from the environment. */
import { Client } from "@upkeep/api";
import { Config, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";

const clientFor = (url: string, variable: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const token = yield* Config.Redacted(variable);

      return Client.layer({ url, token });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));

/** A client for the server, as the admin in `$UPKEEP_ADMIN_TOKEN`. */
export const adminClient = (url: string) =>
  clientFor(url, "UPKEEP_ADMIN_TOKEN");

/** A client for the server, as the worker in `$UPKEEP_WORKER_TOKEN`. */
export const workerClient = (url: string) =>
  clientFor(url, "UPKEEP_WORKER_TOKEN");

/** An admin client for the server in `$UPKEEP_SERVER`. */
export const adminClientFromEnv = Layer.unwrap(
  Effect.map(Config.String("UPKEEP_SERVER"), adminClient),
);
