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

/** Each worker's agents, as it last told the server. */
export const agents = UpkeepApi.query("jobs", "agents", {});

/** The server's version, shown in the header. */
export const serverVersion = UpkeepApi.query("system", "version", {});

/** The latest runs, of every job or one. */
export const runs = Atom.family((job: string) =>
  UpkeepApi.query("runs", "list", {
    query: job === "" ? {} : { job },
    reactivityKeys: runsKey,
  }),
);

const inboxKey = ["inbox"];

/** The tracked repositories, with their titles and jobs. */
export const repos = UpkeepApi.query("repos", "list", {
  reactivityKeys: inboxKey,
});

/** The inbox: what changed lately, and what needs a person. */
export const inbox = UpkeepApi.query("inbox", "get", {
  query: {},
  reactivityKeys: [...inboxKey, ...runsKey],
});

/** Mark entries read, or every unread one without `ids`. */
export const markRead = UpkeepApi.runtime.fn(
  (ids: ReadonlyArray<string> | undefined) =>
    UpkeepApi.use((client) =>
      client.inbox.read({ payload: ids === undefined ? {} : { ids } }),
    ).pipe(asDefects, Effect.ensuring(Reactivity.invalidate(inboxKey))),
);

/** Take an entry out of the inbox until something new joins it. */
export const dismissEntry = UpkeepApi.runtime.fn((id: string) =>
  UpkeepApi.use((client) => client.inbox.dismiss({ params: { id } })).pipe(
    asDefects,
    Effect.ensuring(Reactivity.invalidate(inboxKey)),
  ),
);

/**
 * Name a tracked repository by hand, or clear its name with null so a
 * worker's name or its README title shows again.
 */
export const renameRepo = UpkeepApi.runtime.fn(
  ({ repo, name }: { readonly repo: string; readonly name: string | null }) => {
    const [owner = "", rest = ""] = repo.split("/");

    return UpkeepApi.use((client) =>
      client.repos.rename({ params: { owner, name: rest }, payload: { name } }),
    ).pipe(asDefects, Effect.ensuring(Reactivity.invalidate(inboxKey)));
  },
);

const attentionKey = ["attention"];

/** The Attention page: every item by section, and what moved lately. */
export const attention = UpkeepApi.query("attention", "get", {
  reactivityKeys: [...attentionKey, ...runsKey],
});

/**
 * Opening the Attention page: note the visit, so Since you last looked
 * starts at the one before, then queue a collection when the last is old.
 */
export const openAttention = UpkeepApi.runtime.fn(() =>
  UpkeepApi.use((client) =>
    client.attention.looked().pipe(Effect.andThen(client.attention.refresh())),
  ).pipe(
    asDefects,
    Effect.ensuring(Reactivity.invalidate([...attentionKey, ...runsKey])),
  ),
);

/** Hide an attention item until anything about it changes, or show it. */
export const hideAttention = UpkeepApi.runtime.fn(
  (payload: { readonly url: string; readonly hidden: boolean }) =>
    UpkeepApi.use((client) => client.attention.hide({ payload })).pipe(
      asDefects,
      Effect.ensuring(Reactivity.invalidate(attentionKey)),
    ),
);

/** Mark a notification read on GitHub, through a worker. */
export const markNotificationRead = UpkeepApi.runtime.fn((thread: string) =>
  UpkeepApi.use((client) =>
    client.attention.command({ payload: { kind: "mark-read", thread } }),
  ).pipe(
    asDefects,
    Effect.ensuring(Reactivity.invalidate([...attentionKey, ...runsKey])),
  ),
);

/** Open an agent on an item or a group, on the worker given. */
export const startAgent = UpkeepApi.runtime.fn(
  (payload: {
    readonly worker: string;
    readonly url: string | null;
    readonly group: string | null;
    readonly prompt: string | null;
  }) =>
    UpkeepApi.use((client) =>
      client.attention.command({
        payload: { kind: "start-agent", ...payload },
      }),
    ).pipe(asDefects, Effect.ensuring(Reactivity.invalidate(runsKey))),
);

/** Start a group of work with the items given in it. */
export const createGroup = UpkeepApi.runtime.fn(
  (payload: { readonly name: string; readonly items: ReadonlyArray<string> }) =>
    UpkeepApi.use((client) => client.attention.createGroup({ payload })).pipe(
      asDefects,
      Effect.ensuring(Reactivity.invalidate(attentionKey)),
    ),
);

/** Rename a group, or change its focus. */
export const updateGroup = UpkeepApi.runtime.fn(
  ({
    id,
    ...payload
  }: {
    readonly id: string;
    readonly name?: string;
    readonly focus?: Domain.AttentionFocus;
  }) =>
    UpkeepApi.use((client) =>
      client.attention.updateGroup({ params: { id }, payload }),
    ).pipe(asDefects, Effect.ensuring(Reactivity.invalidate(attentionKey))),
);

/** Remove a group; its items go back to their sections. */
export const deleteGroup = UpkeepApi.runtime.fn((id: string) =>
  UpkeepApi.use((client) =>
    client.attention.deleteGroup({ params: { id } }),
  ).pipe(asDefects, Effect.ensuring(Reactivity.invalidate(attentionKey))),
);

/** Move an item into a group, or out of any with null. */
export const linkAttention = UpkeepApi.runtime.fn(
  (payload: { readonly url: string; readonly group: string | null }) =>
    UpkeepApi.use((client) => client.attention.link({ payload })).pipe(
      asDefects,
      Effect.ensuring(Reactivity.invalidate(attentionKey)),
    ),
);

/** Note something outside GitHub a group waits on. */
export const addWait = UpkeepApi.runtime.fn(
  ({ group, text }: { readonly group: string; readonly text: string }) =>
    UpkeepApi.use((client) =>
      client.attention.addWait({ params: { id: group }, payload: { text } }),
    ).pipe(asDefects, Effect.ensuring(Reactivity.invalidate(attentionKey))),
);

export const removeWait = UpkeepApi.runtime.fn((id: string) =>
  UpkeepApi.use((client) =>
    client.attention.removeWait({ params: { id } }),
  ).pipe(asDefects, Effect.ensuring(Reactivity.invalidate(attentionKey))),
);

/** Tell the context agent something about an item or a group. */
export const commentAttention = UpkeepApi.runtime.fn(
  (
    payload:
      | { readonly url: string; readonly text: string }
      | { readonly group: string; readonly text: string },
  ) =>
    UpkeepApi.use((client) => client.attention.comment({ payload })).pipe(
      asDefects,
      Effect.ensuring(Reactivity.invalidate([...attentionKey, ...runsKey])),
    ),
);

/** Give the context agent a standing instruction. */
export const addRule = UpkeepApi.runtime.fn((text: string) =>
  UpkeepApi.use((client) =>
    client.attention.addRule({ payload: { text } }),
  ).pipe(asDefects, Effect.ensuring(Reactivity.invalidate(attentionKey))),
);

export const removeRule = UpkeepApi.runtime.fn((id: string) =>
  UpkeepApi.use((client) =>
    client.attention.removeRule({ params: { id } }),
  ).pipe(asDefects, Effect.ensuring(Reactivity.invalidate(attentionKey))),
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
    Effect.ensuring(Reactivity.invalidate([...runsKey, ...inboxKey])),
  ),
);

export const pauseJob = UpkeepApi.runtime.fn((job: string) =>
  UpkeepApi.use((client) => client.jobs.pause({ params: { id: job } })).pipe(
    asDefects,
    Effect.ensuring(Reactivity.invalidate(runsKey)),
  ),
);

export const resumeJob = UpkeepApi.runtime.fn((job: string) =>
  UpkeepApi.use((client) => client.jobs.resume({ params: { id: job } })).pipe(
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

/** Run a finished run again, then show the new run. */
export const retryRun = UpkeepApi.runtime.fn((id: string) =>
  UpkeepApi.use((client) => client.runs.retry({ params: { id } })).pipe(
    asDefects,
    Effect.tap((queued) =>
      Effect.sync(() => {
        history.pushState(
          null,
          "",
          new URL(runHref(queued.id), document.baseURI).href,
        );
        window.dispatchEvent(new PopStateEvent("popstate"));
      }),
    ),
    Effect.ensuring(Reactivity.invalidate([...runsKey, ...inboxKey])),
  ),
);

/** Clear what a run left for a person, and its inbox entry. */
export const dismissRun = UpkeepApi.runtime.fn((id: string) =>
  UpkeepApi.use((client) => client.runs.dismiss({ params: { id } })).pipe(
    asDefects,
    Effect.ensuring(Reactivity.invalidate([...runsKey, ...inboxKey])),
  ),
);

export type Route = Data.TaggedEnum<{
  Inbox: {};
  Attention: {};
  Repos: {};
  Repo: { readonly repo: string };
  Jobs: {};
  Job: { readonly id: string };
  Run: { readonly id: string };
}>;

export const Route = Data.taggedEnum<Route>();

/** Where the dashboard lives, from the page's `<base>`. */
const basePath = new URL(document.baseURI).pathname;

const jobsPattern = new URLPattern({ pathname: "/jobs{/}?" });

const reposPattern = new URLPattern({ pathname: "/repos{/}?" });

const attentionPattern = new URLPattern({ pathname: "/attention{/}?" });

const repoPattern = new URLPattern({ pathname: "/repos/:owner/:name" });

const jobPattern = new URLPattern({ pathname: "/jobs/:id" });

const runPattern = new URLPattern({ pathname: "/runs/:id" });

const parseRoute = (): Route => {
  const path = location.pathname.startsWith(basePath)
    ? `/${location.pathname.slice(basePath.length)}`
    : location.pathname;

  if (jobsPattern.test({ pathname: path })) return Route.Jobs();

  if (reposPattern.test({ pathname: path })) return Route.Repos();

  if (attentionPattern.test({ pathname: path })) return Route.Attention();

  const repo = repoPattern.exec({ pathname: path })?.pathname.groups;

  if (repo?.["owner"] !== undefined && repo["name"] !== undefined) {
    return Route.Repo({
      repo: `${decodeURIComponent(repo["owner"])}/${decodeURIComponent(repo["name"])}`,
    });
  }

  const job = jobPattern.exec({ pathname: path })?.pathname.groups["id"];

  if (job !== undefined) return Route.Job({ id: decodeURIComponent(job) });

  const id = runPattern.exec({ pathname: path })?.pathname.groups["id"];

  return id === undefined
    ? Route.Inbox()
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

export const jobsHref = "jobs";

export const reposHref = "repos";

export const attentionHref = "attention";

/** A tracked repository's page, by `owner/name`. */
export const repoHref = (repo: string) =>
  `repos/${repo.split("/").map(encodeURIComponent).join("/")}`;

export const jobHref = (id: string) => `jobs/${encodeURIComponent(id)}`;

export const runHref = (id: string) => `runs/${encodeURIComponent(id)}`;
