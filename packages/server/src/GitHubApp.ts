/**
 * The GitHub App's installation tokens. Workers run their jobs' own `gh` and
 * `git` calls with one, so bulk work counts against the App's rate limit and
 * shows as the App, with the App's bot credited as co-author on its commits,
 * while heals and coding agents keep the machine's login.
 * The server holds the App's private key and mints a token when the one it
 * has is within ten minutes of expiring; without the App set up, there's no
 * token and workers use their machine's login as before.
 */
import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import type { Domain } from "@upkeep/api";
import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  SynchronizedRef,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

/** How long before it expires a token is replaced. */
const refreshMs = 10 * 60_000;

/** Why a token couldn't be made. */
export class GitHubAppError extends Schema.TaggedError<GitHubAppError>()(
  "GitHubAppError",
  { message: Schema.String },
) {}

const Installations = Schema.Array(
  Schema.Struct({
    id: Schema.Finite,
    account: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  }),
);

const AccessToken = Schema.Struct({
  token: Schema.String,
  expires_at: Schema.String,
});

const App = Schema.Struct({ slug: Schema.String });

const BotUser = Schema.Struct({ id: Schema.Finite, login: Schema.String });

export class GitHubApp extends Context.Service<
  GitHubApp,
  {
    /** Whether an App is set up; without one, there are no tokens. */
    readonly enabled: boolean;
    /** A token good for at least ten more minutes, or none without an App. */
    readonly token: () => Effect.Effect<
      Option.Option<Domain.GitHubToken>,
      GitHubAppError
    >;
  }
>()("@upkeep/server/GitHubApp") {
  static readonly none = Layer.succeed(
    GitHubApp,
    GitHubApp.of({
      enabled: false,
      token: () => Effect.succeedNone,
    }),
  );

  /**
   * The App `$UPKEEP_GITHUB_APP_ID` with the private key in
   * `$UPKEEP_GITHUB_APP_KEY`, as the `.pem` GitHub gives or that file in
   * base64. It uses the App's only installation, or the one on
   * `$UPKEEP_GITHUB_APP_ACCOUNT` when it's installed on more than one account.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const settings = yield* Config.all({
        app: Config.String("UPKEEP_GITHUB_APP_ID"),
        key: Config.Redacted("UPKEEP_GITHUB_APP_KEY"),
        account: Config.option(Config.String("UPKEEP_GITHUB_APP_ACCOUNT")),
      }).pipe(Config.option);

      if (Option.isNone(settings)) return GitHubApp.none;

      const key = yield* Effect.try({
        try: () => createPrivateKey(pem(Redacted.value(settings.value.key))),
        catch: () =>
          new GitHubAppError({
            message:
              "The GitHub App's private key couldn't be read: give the .pem, or the file in base64",
          }),
      }).pipe(Effect.option);

      if (Option.isNone(key)) {
        yield* Effect.logWarning(
          "The GitHub App's private key couldn't be read, so workers use their machine's login",
        );

        return GitHubApp.none;
      }

      yield* Effect.logInfo(
        "Handing workers GitHub App tokens for the jobs' GitHub calls",
      );

      return Layer.effect(
        GitHubApp,
        make({ ...settings.value, key: key.value }),
      );
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

/**
 * The key as PEM, from the file as it is, on one line with its newlines
 * flattened to spaces or escaped, as a password field keeps it, or in base64.
 */
export const pem = (value: string) => {
  const text = value.trim().startsWith("-----BEGIN")
    ? value
    : Buffer.from(value.trim(), "base64").toString("utf8");

  const parts = /-----BEGIN ([A-Z ]+)-----(.+?)-----END \1-----/s.exec(text);

  if (parts === null) return text;

  const [, label = "", body = ""] = parts;

  const lines = body
    .replaceAll("\\n", "")
    .replace(/\s+/g, "")
    .match(/.{1,64}/g);

  return [
    `-----BEGIN ${label}-----`,
    ...(lines ?? []),
    `-----END ${label}-----`,
  ].join("\n");
};

const base64url = (data: string | Uint8Array) =>
  Buffer.from(data).toString("base64url");

/** A JWT for the App itself, good for nine minutes, back-dated for clock skew. */
export const appJwt = (app: string, key: KeyObject, now: number) => {
  const seconds = Math.floor(now / 1000);

  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: app }),
  )}`;

  return `${unsigned}.${base64url(sign("sha256", Buffer.from(unsigned), key))}`;
};

const make = Effect.fnUntraced(function* (options: {
  readonly app: string;
  readonly key: KeyObject;
  readonly account: Option.Option<string>;
}) {
  const http = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl("https://api.github.com"),
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeaders({
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "upkeep",
        }),
      ),
    ),
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({
      schedule: Schedule.exponential("500 millis"),
      times: 3,
    }),
  );

  const asApp = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.clockWith((clock) =>
      http.execute(
        HttpClientRequest.bearerToken(
          request,
          appJwt(options.app, options.key, clock.currentTimeMillisUnsafe()),
        ),
      ),
    );

  const installation = Effect.gen(function* () {
    const installations = yield* asApp(
      HttpClientRequest.get("/app/installations"),
    ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Installations)));

    const chosen = Option.match(options.account, {
      onNone: () => (installations.length === 1 ? installations[0] : undefined),
      onSome: (account) =>
        installations.find(
          (each) => each.account?.login.toLowerCase() === account.toLowerCase(),
        ),
    });

    if (chosen === undefined || chosen.account === null) {
      return yield* new GitHubAppError({
        message:
          installations.length === 0
            ? "The GitHub App isn't installed anywhere"
            : Option.match(options.account, {
                onNone: () =>
                  "The GitHub App is installed on more than one account: set github_app_account to the one to use",
                onSome: (account) =>
                  `The GitHub App isn't installed on ${account}`,
              }),
      });
    }

    return { id: chosen.id, account: chosen.account.login };
  });

  /**
   * The App's bot as a `Co-authored-by` trailer names it, read once: the App
   * JWT reads its slug, and the new installation token its bot account's ID,
   * which GitHub's noreply address needs.
   */
  const coAuthor = yield* SynchronizedRef.make(Option.none<string>());

  const lookUpCoAuthor = (token: string) =>
    SynchronizedRef.modifyEffect(coAuthor, (held) =>
      Option.isSome(held)
        ? Effect.succeed([held, held] as const)
        : Effect.gen(function* () {
            const { slug } = yield* asApp(HttpClientRequest.get("/app")).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(App)),
            );

            const bot = yield* http
              .execute(
                HttpClientRequest.bearerToken(
                  HttpClientRequest.get(
                    `/users/${encodeURIComponent(`${slug}[bot]`)}`,
                  ),
                  token,
                ),
              )
              .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(BotUser)));

            const found = Option.some(
              `${bot.login} <${bot.id}+${bot.login}@users.noreply.github.com>`,
            );

            return [found, found] as const;
          }).pipe(
            // Tokens matter more than the credit, so a failed lookup is
            // tried again with the next token
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "Couldn't look up the GitHub App's bot, so commits go without its co-author credit",
                cause,
              ).pipe(Effect.as([Option.none<string>(), held] as const)),
            ),
          ),
    );

  const mint = Effect.gen(function* () {
    const { id, account } = yield* installation;

    const minted = yield* asApp(
      HttpClientRequest.post(`/app/installations/${id}/access_tokens`),
    ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(AccessToken)));

    const token = minted.token;
    const expiresAt = Date.parse(minted.expires_at);

    return Option.match(yield* lookUpCoAuthor(token), {
      onNone: (): Domain.GitHubToken => ({ token, expiresAt, account }),
      onSome: (coAuthor): Domain.GitHubToken => ({
        token,
        expiresAt,
        account,
        coAuthor,
      }),
    });
  }).pipe(
    Effect.catchTags({
      HttpClientError: (error) =>
        Effect.fail(
          new GitHubAppError({
            message: `Couldn't get a GitHub App token: ${error.message}`,
          }),
        ),
      SchemaError: (error) =>
        Effect.fail(
          new GitHubAppError({
            message: `GitHub answered with something unexpected: ${error.message}`,
          }),
        ),
    }),
  );

  const current = yield* SynchronizedRef.make<
    Option.Option<Domain.GitHubToken>
  >(Option.none());

  return GitHubApp.of({
    enabled: true,
    token: () =>
      SynchronizedRef.modifyEffect(current, (held) =>
        Effect.clockWith((clock) => {
          const now = clock.currentTimeMillisUnsafe();

          if (Option.isSome(held) && held.value.expiresAt - now > refreshMs) {
            return Effect.succeed([held, held] as const);
          }

          return mint.pipe(
            Effect.map(
              (token) => [Option.some(token), Option.some(token)] as const,
            ),
          );
        }),
      ),
  });
});
