/**
 * Issues and checks the server's tokens, keeping only their SHA-256 hashes.
 * Admin tokens read jobs and runs and manage tokens; worker tokens take runs
 * and report on them.
 */
import { Api } from "@upkeep/api";
import { Config, Context, Effect, Layer, Option, Redacted } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { Base64Url } from "effect/encoding";
import { Store, type StoreError } from "./Store";

/** The admin name requests with the token from settings are made as. */
export const settingsAdmin = "settings";

/** The shortest token accepted from settings, to keep it unguessable. */
const minimumSettingsToken = 32;

export class Tokens extends Context.Service<
  Tokens,
  {
    /** Issue a token, which is only ever returned here. */
    issue(
      scope: Api.TokenScope,
      name: string,
    ): Effect.Effect<Redacted.Redacted, Api.TokenExists | StoreError>;
    /** The name a token belongs to in a scope, if any. */
    authenticate(
      scope: Api.TokenScope,
      token: Redacted.Redacted,
    ): Effect.Effect<Option.Option<string>, StoreError>;
    list(
      scope: Api.TokenScope,
    ): Effect.Effect<ReadonlyArray<Api.Token>, StoreError>;
    revoke(
      scope: Api.TokenScope,
      name: string,
    ): Effect.Effect<void, Api.TokenNotFound | StoreError>;
  }
>()("@upkeep/server/Tokens") {
  /**
   * Tokens kept in the store. `$UPKEEP_SERVER_ADMIN_TOKEN`, when set, also
   * works as an admin token, for servers you can't run `upkeep` commands on,
   * such as the Home Assistant app. It isn't stored or listed.
   */
  static readonly layer = Layer.effect(
    Tokens,
    Effect.gen(function* () {
      const store = yield* Store;
      const digest = yield* Digest.Digest;
      const random = yield* SecureRandom.SecureRandom;

      const hash = (token: Redacted.Redacted) =>
        digest.digestHex(
          Digest.sha256,
          new TextEncoder().encode(Redacted.value(token)),
        );

      const settingsToken = yield* Config.option(
        Config.Redacted("UPKEEP_SERVER_ADMIN_TOKEN"),
      );

      if (
        Option.isSome(settingsToken) &&
        Redacted.value(settingsToken.value).length < minimumSettingsToken
      ) {
        return yield* Effect.die(
          new Error(
            `UPKEEP_SERVER_ADMIN_TOKEN must be at least ${minimumSettingsToken} characters`,
          ),
        );
      }

      const settingsHash = yield* Effect.transposeOption(
        Option.map(settingsToken, hash),
      );

      const issue = Effect.fn("Tokens.issue")(function* (
        scope: Api.TokenScope,
        name: string,
      ) {
        const token = Redacted.make(
          Base64Url.encode(yield* random.randomBytes(32)),
        );

        if (!(yield* store.addToken(scope, name, yield* hash(token)))) {
          return yield* new Api.TokenExists({ scope, holder: name });
        }

        return token;
      });

      const authenticate = Effect.fn("Tokens.authenticate")(function* (
        scope: Api.TokenScope,
        token: Redacted.Redacted,
      ) {
        const tokenHash = yield* hash(token);

        if (scope === "admin" && Option.contains(settingsHash, tokenHash)) {
          return Option.some(settingsAdmin);
        }

        return yield* store.tokenName(scope, tokenHash);
      });

      const revoke = Effect.fn("Tokens.revoke")(function* (
        scope: Api.TokenScope,
        name: string,
      ) {
        if (!(yield* store.removeToken(scope, name))) {
          return yield* new Api.TokenNotFound({ scope, holder: name });
        }
      });

      return Tokens.of({
        issue,
        authenticate,
        list: (scope) => store.tokens(scope),
        revoke,
      });
    }),
  ).pipe(Layer.provide([Digest.layerWebCrypto, SecureRandom.layerWebCrypto]));
}
