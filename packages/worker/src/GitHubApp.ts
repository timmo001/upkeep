/**
 * Runs as the GitHub App. The jobs that work across repositories on their
 * own, such as bumps and syncs, run their `gh` and `git` calls with an
 * installation token the server hands out, so bulk work counts against the
 * App's rate limit and shows as the App, and their commits credit the App's
 * bot as co-author. Heals, agents and the jobs that read what involves you
 * keep the machine's login, as does bump's code search.
 * Without an App on the server, or with a server too old to have one, every
 * job uses the machine's login.
 */
import {
  Api,
  Gh,
  layer as ghLayer,
  type Interface as GhInterface,
} from "@timmo001/effect-gh";
import { Catalogue, Client, type Domain } from "@upkeep/api";
import {
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Schema,
  SynchronizedRef,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** The jobs that run as the App. */
const appJobs: ReadonlySet<string> = new Set(
  [
    Catalogue.bump,
    Catalogue.labels,
    Catalogue.stalledUpdates,
    Catalogue.drift,
    Catalogue.sync,
    Catalogue.deps,
    Catalogue.watch,
    Catalogue.skillConsumers,
  ].map(({ id }) => id),
);

/** How long before it expires a token is replaced. */
const refreshMs = 10 * 60_000;

/** How long to wait before asking again after the server had no token. */
const retryMs = 5 * 60_000;

/**
 * The account the App is installed on, for a run that acts as the App, which
 * stands in for the signed-in user.
 */
export const Account = Context.Reference<Option.Option<string>>(
  "@upkeep/worker/GitHubApp/Account",
  { defaultValue: () => Option.none() },
);

/**
 * The App's bot, credited with `Co-authored-by` on the commits a run that
 * acts as the App makes on its own. Work that waits for you, such as a skill
 * change, runs with the machine's login and is credited to you alone.
 */
export const CoAuthor = Context.Reference<Option.Option<string>>(
  "@upkeep/worker/GitHubApp/CoAuthor",
  { defaultValue: () => Option.none() },
);

/** `git commit`'s arguments for crediting the bot, when the run has one. */
export const coAuthorTrailer = Effect.map(CoAuthor, (coAuthor) =>
  Option.match(coAuthor, {
    onNone: (): ReadonlyArray<string> => [],
    onSome: (who) => ["--trailer", `Co-authored-by: ${who}`],
  }),
);

/**
 * The machine's own `gh`, for a run that acts as the App. None when the run
 * keeps the machine's login anyway.
 */
export const MachineGh = Context.Reference<Option.Option<GhInterface>>(
  "@upkeep/worker/GitHubApp/MachineGh",
  { defaultValue: () => Option.none() },
);

/**
 * Run `gh` calls with the machine's login, even in a run that acts as the App.
 * Code search with an installation token reports every match in its count but
 * returns only some of them, differing from one call to the next.
 */
export const withMachineLogin = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(MachineGh, (machine) =>
    Option.match(machine, {
      onNone: () => effect,
      onSome: (gh) => Effect.provideService(effect, Gh, gh),
    }),
  );

const User = Schema.Struct({ login: Schema.String });

/**
 * Whose repositories the jobs work on: the App's account, or the signed-in
 * user, since an installation token can't read `GET /user`.
 */
export const login = Effect.gen(function* () {
  const account = yield* Account;

  if (Option.isSome(account)) return account.value;

  const { login } = yield* Api.json({ endpoint: "user", method: "GET" }, User);

  return login;
});

/**
 * What a subprocess needs to act as the App: `gh` reads the token from
 * `GH_TOKEN`, and `git` is pointed at GitHub over HTTPS, even for a clone with
 * an SSH remote, with a credential helper that hands it the same token.
 */
const environment = (token: string) => ({
  GH_TOKEN: token,
  GIT_CONFIG_COUNT: "4",
  GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
  GIT_CONFIG_VALUE_0: "git@github.com:",
  GIT_CONFIG_KEY_1: "url.https://github.com/.insteadOf",
  GIT_CONFIG_VALUE_1: "ssh://git@github.com/",
  // An empty helper clears any the machine has, so only the token is offered
  GIT_CONFIG_KEY_2: "credential.https://github.com.helper",
  GIT_CONFIG_VALUE_2: "",
  GIT_CONFIG_KEY_3: "credential.https://github.com.helper",
  GIT_CONFIG_VALUE_3:
    '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f',
});

interface Held {
  readonly token: Option.Option<Domain.GitHubToken>;
  /** When to ask the server again. */
  readonly until: number;
}

/**
 * The worker's App tokens, asked of the server as they near expiry and shared
 * by every run. `forRun` gives the services a run of a job is given: for a
 * job that runs as the App while the server has a token, a spawner and `gh`
 * that act as the App; otherwise none, so it keeps the machine's login.
 */
export const make = Effect.gen(function* () {
  const client = yield* Client;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const machine = yield* Gh;

  const held = yield* SynchronizedRef.make<Held>({
    token: Option.none(),
    until: 0,
  });

  const current = SynchronizedRef.modifyEffect(held, (was) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      if (now < was.until) return [was.token, was] as const;

      const token = yield* client.work.githubToken().pipe(
        Effect.map(Option.fromNullishOr),
        Effect.catchCause((cause) =>
          Effect.logDebug(
            "Couldn't get a GitHub App token, so using the machine's login",
            cause,
          ).pipe(Effect.as(Option.none<Domain.GitHubToken>())),
        ),
      );

      const until = Option.match(token, {
        onNone: () => now + retryMs,
        onSome: ({ expiresAt }) => expiresAt - refreshMs,
      });

      return [token, { token, until }] as const;
    }),
  );

  // Each subprocess takes the token current when it starts, so a long run
  // carries on past the hour one token lasts
  const asApp = ChildProcessSpawner.make((command) =>
    current.pipe(
      Effect.flatMap((token) =>
        spawner.spawn(
          Option.match(token, {
            onNone: () => command,
            onSome: ({ token }) =>
              ChildProcess.setEnv(command, environment(token)),
          }),
        ),
      ),
    ),
  );

  const forRun = Effect.fnUntraced(function* (job: string) {
    if (!appJobs.has(job)) return Layer.empty;

    const token = yield* current;

    if (Option.isNone(token)) return Layer.empty;

    const spawning = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      asApp,
    );

    return Layer.mergeAll(
      spawning,
      ghLayer().pipe(Layer.provide(spawning)),
      Layer.succeed(Account, Option.some(token.value.account)),
      Layer.succeed(CoAuthor, Option.fromUndefinedOr(token.value.coAuthor)),
      Layer.succeed(MachineGh, Option.some(machine)),
    );
  });

  return { forRun };
});

/** The worker's App tokens, as {@link make} gives them. */
export type Runs = Effect.Success<typeof make>;
