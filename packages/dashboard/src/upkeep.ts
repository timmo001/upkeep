/**
 * The dashboard's state: the admin token, the Upkeep API as atoms, and the
 * route from the page's path. Everything resolves against the page's base, so
 * it works at `/` and under Home Assistant ingress alike.
 */
import { BrowserKeyValueStore } from "@effect/platform-browser";
import { Api, type Domain } from "@upkeep/api";
import { Data, Effect, Layer, Option, Schedule, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";
import { Atom, AtomHttpApi, Reactivity } from "effect/reactivity";

const storage = Atom.runtime(BrowserKeyValueStore.layerLocalStorage);

/** The admin token, kept in the browser. Empty until someone signs in. */
export const token = Atom.kvs({
  runtime: storage,
  key: "upkeep-admin-token",
  schema: Schema.String,
  defaultValue: () => "",
});

export class UpkeepApi extends AtomHttpApi.Service<UpkeepApi>()(
  "@upkeep/dashboard/UpkeepApi",
  {
    api: Api.Api,
    httpClient: (get) => {
      const bearer: HttpApiMiddleware.HttpApiMiddlewareClient<
        never,
        never,
        never
      > = ({ next, request }) =>
        next(HttpClientRequest.bearerToken(request, get(token)));

      return Layer.mergeAll(
        FetchHttpClient.layer,
        HttpApiMiddleware.layerClient(Api.AdminAuthorization, bearer),
        HttpApiMiddleware.layerClient(Api.WorkerAuthorization, bearer),
      );
    },
    baseUrl: new URL(".", document.baseURI).href.replace(/\/$/, ""),
    // Covers the server restarting, so a poll doesn't show an error.
    transformClient: HttpClient.retryTransient({
      schedule: Schedule.exponential("250 millis"),
      times: 5,
    }),
  },
) {}

const runsKey = ["runs"];

/** Requests that couldn't be made or understood are defects, as in queries. */
const asDefects = <A, E, R>(
  effect: Effect.Effect<
    A,
    E | HttpClientError.HttpClientError | Schema.SchemaError,
    R
  >,
) =>
  Effect.catchIf(
    effect,
    (error) =>
      Schema.isSchemaError(error) || HttpClientError.isHttpClientError(error),
    (error) => Effect.die(error),
  );

export const jobs = UpkeepApi.query("jobs", "list", {
  reactivityKeys: runsKey,
});

/** The latest runs, of every job or one. */
export const runs = Atom.family((job: string) =>
  UpkeepApi.query("runs", "list", {
    query: job === "" ? {} : { job },
    reactivityKeys: runsKey,
  }),
);

export const run = Atom.family((id: string) =>
  UpkeepApi.query("runs", "get", {
    params: { id },
    reactivityKeys: runsKey,
  }),
);

const ended = (state: Domain.RunState) =>
  state !== "queued" && state !== "running";

/**
 * A run's log as it grows: every line so far, fetched a page at a time and
 * then every two seconds until the run ends. The run is read before each
 * page, so once it has ended that page holds the last of its lines.
 */
export const runLog = Atom.family((id: string) =>
  UpkeepApi.runtime.atom(
    Stream.paginate({ after: 0, wait: false }, ({ after, wait }) =>
      UpkeepApi.use((client) =>
        Effect.gen(function* () {
          if (wait) yield* Effect.sleep("2 seconds");

          const current = yield* client.runs.get({ params: { id } });

          const lines = yield* client.runs.log({
            params: { id },
            query: { after },
          });

          const next = lines.at(-1)?.seq ?? after;

          if (lines.length >= Api.maxLogLines) {
            return [lines, Option.some({ after: next, wait: false })] as const;
          }

          return [
            lines,
            ended(current.state)
              ? Option.none()
              : Option.some({ after: next, wait: true }),
          ] as const;
        }),
      ).pipe(asDefects),
    ).pipe(
      Stream.chunks,
      Stream.scan(
        (): ReadonlyArray<Domain.LogLine> => [],
        (all, lines): ReadonlyArray<Domain.LogLine> => [...all, ...lines],
      ),
    ),
  ),
);

/** Queue a run of a job by hand, then refresh everything showing runs. */
export const runJob = UpkeepApi.runtime.fn((job: string) =>
  UpkeepApi.use((client) =>
    client.jobs.run({ params: { id: job }, payload: {} }),
  ).pipe(asDefects, Effect.ensuring(Reactivity.invalidate(runsKey))),
);

export const unparkJob = UpkeepApi.runtime.fn((job: string) =>
  UpkeepApi.use((client) => client.jobs.unpark({ params: { id: job } })).pipe(
    asDefects,
    Effect.ensuring(Reactivity.invalidate(runsKey)),
  ),
);

export const cancelRun = UpkeepApi.runtime.fn((id: string) =>
  UpkeepApi.use((client) => client.runs.cancel({ params: { id } })).pipe(
    asDefects,
    Effect.ensuring(Reactivity.invalidate(runsKey)),
  ),
);

export type Route = Data.TaggedEnum<{
  Overview: {};
  Job: { readonly id: string };
  Run: { readonly id: string };
}>;

export const Route = Data.taggedEnum<Route>();

/** Where the dashboard lives, from the page's `<base>`. */
const basePath = new URL(document.baseURI).pathname;

const jobPattern = new URLPattern({ pathname: "/jobs/:id" });

const runPattern = new URLPattern({ pathname: "/runs/:id" });

const parseRoute = (): Route => {
  const path = location.pathname.startsWith(basePath)
    ? `/${location.pathname.slice(basePath.length)}`
    : location.pathname;

  const job = jobPattern.exec({ pathname: path })?.pathname.groups["id"];

  if (job !== undefined) return Route.Job({ id: decodeURIComponent(job) });

  const id = runPattern.exec({ pathname: path })?.pathname.groups["id"];

  return id === undefined
    ? Route.Overview()
    : Route.Run({ id: decodeURIComponent(id) });
};

/** The link within the dashboard that a click lands on, if any. */
const appLink = (event: MouseEvent) => {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return undefined;
  }

  const link = event
    .composedPath()
    .find((target) => target instanceof HTMLAnchorElement);

  if (
    link === undefined ||
    link.target !== "" ||
    link.hasAttribute("download") ||
    link.origin !== location.origin ||
    !link.pathname.startsWith(basePath)
  ) {
    return undefined;
  }

  return link;
};

/**
 * The page to show, from the URL's path. Links within the dashboard change the
 * path without reloading, and the back and forward buttons follow it.
 */
export const route = Atom.readable((get) => {
  const update = () => get.setSelf(parseRoute());

  const onClick = (event: MouseEvent) => {
    const link = appLink(event);

    if (link === undefined) return;

    event.preventDefault();

    if (link.href !== location.href) {
      history.pushState(null, "", link.href);
      window.scrollTo(0, 0);
      update();
    }
  };

  window.addEventListener("popstate", update);
  document.addEventListener("click", onClick);
  get.addFinalizer(() => {
    window.removeEventListener("popstate", update);
    document.removeEventListener("click", onClick);
  });

  return parseRoute();
});

/** Links resolve against the page's base, so they work under any prefix. */
export const homeHref = "./";

export const jobHref = (id: string) => `jobs/${encodeURIComponent(id)}`;

export const runHref = (id: string) => `runs/${encodeURIComponent(id)}`;
