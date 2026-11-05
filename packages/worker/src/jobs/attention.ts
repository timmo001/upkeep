/**
 * The attention job: read every open pull request and issue that involves
 * you, the ones waiting on your review, the open ones on tracked repositories
 * and the worker's own searches, plus unread notifications, and send them to
 * the server for the Attention page. Each item carries GitHub's signals, such
 * as changes requested, failing checks or conflicts, which decide its section
 * there. Notifications and base branch reads are conditional, so a quiet
 * period costs little.
 */
import { Api, Graphql } from "@timmo001/effect-gh";
import type { Domain } from "@upkeep/api";
import { homedir } from "node:os";
import { Clock, Effect, Schema } from "effect";
import { reason } from "../Failure";
import * as Kept from "../Kept";
import { Reporter, summary } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { run } from "./bump";

const day = 86_400_000;

/** How many results each search reads at most. */
const maxPerSearch = 300;

/** How many of your pull requests have their base branch checked each run. */
const maxBaseChecks = 30;

const Author = Schema.NullOr(
  Schema.Struct({ __typename: Schema.String, login: Schema.String }),
);

const Event = Schema.Struct({ author: Author, createdAt: Schema.String });

const Common = {
  url: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  author: Author,
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
  comments: Schema.Struct({ nodes: Schema.Array(Schema.NullOr(Event)) }),
  participants: Schema.Struct({
    nodes: Schema.Array(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
  }),
};

const Pull = Schema.Struct({
  __typename: Schema.Literal("PullRequest"),
  ...Common,
  isDraft: Schema.Boolean,
  mergeable: Schema.String,
  reviewDecision: Schema.NullOr(Schema.String),
  headRefOid: Schema.String,
  baseRefName: Schema.String,
  commits: Schema.Struct({
    nodes: Schema.Array(
      Schema.NullOr(
        Schema.Struct({
          commit: Schema.Struct({
            committedDate: Schema.String,
            statusCheckRollup: Schema.NullOr(
              Schema.Struct({ state: Schema.String }),
            ),
          }),
        }),
      ),
    ),
  }),
  reviewRequests: Schema.Struct({
    nodes: Schema.Array(
      Schema.NullOr(
        Schema.Struct({
          requestedReviewer: Schema.NullOr(
            Schema.Struct({ login: Schema.optionalKey(Schema.String) }),
          ),
        }),
      ),
    ),
  }),
  reviewThreads: Schema.Struct({
    nodes: Schema.Array(
      Schema.NullOr(
        Schema.Struct({
          isResolved: Schema.Boolean,
          comments: Schema.Struct({
            nodes: Schema.Array(
              Schema.NullOr(Schema.Struct({ author: Author })),
            ),
          }),
        }),
      ),
    ),
  }),
  latestReviews: Schema.Struct({
    nodes: Schema.Array(
      Schema.NullOr(
        Schema.Struct({
          author: Author,
          state: Schema.String,
          submittedAt: Schema.NullOr(Schema.String),
        }),
      ),
    ),
  }),
});

export type Pull = typeof Pull.Type;

const Issue = Schema.Struct({
  __typename: Schema.Literal("Issue"),
  ...Common,
});

export type Issue = typeof Issue.Type;

const common = `
  url number title createdAt updatedAt
  author { __typename login }
  repository { nameWithOwner }
  comments(last: 1) { nodes { author { __typename login } createdAt } }
  participants(first: 10) { nodes { login } }
`;

const document = `
  query ($q: String!, $after: String) {
    search(query: $q, type: ISSUE, first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        __typename
        ... on PullRequest {
          ${common}
          isDraft mergeable reviewDecision headRefOid baseRefName
          commits(last: 1) {
            nodes { commit { committedDate statusCheckRollup { state } } }
          }
          reviewRequests(first: 20) {
            nodes { requestedReviewer { ... on User { login } } }
          }
          reviewThreads(first: 50) {
            nodes {
              isResolved
              comments(last: 1) { nodes { author { __typename login } } }
            }
          }
          latestReviews(first: 20) {
            nodes { author { __typename login } state submittedAt }
          }
        }
        ... on Issue { ${common} }
      }
    }
  }
`;

const Page = Schema.Struct({
  search: Schema.Struct({
    pageInfo: Schema.Struct({
      hasNextPage: Schema.Boolean,
      endCursor: Schema.NullOr(Schema.String),
    }),
    nodes: Schema.Array(
      Schema.NullOr(
        Schema.StructWithRest(Schema.Struct({ __typename: Schema.String }), [
          Schema.Record(Schema.String, Schema.Unknown),
        ]),
      ),
    ),
  }),
});

const decodeItem = Schema.decodeUnknownEffect(Schema.Union([Pull, Issue]));

/** Every pull request and issue a search finds, up to `maxPerSearch`. */
const searchAll = Effect.fnUntraced(function* (q: string) {
  const found: Array<Pull | Issue> = [];
  let after: string | null = null;

  do {
    const page: typeof Page.Type = yield* Graphql.query(
      document,
      { q, after },
      Page,
    );

    // Anything else a search can find, such as a discussion, is left out
    for (const node of page.search.nodes) {
      if (node?.__typename === "PullRequest" || node?.__typename === "Issue") {
        found.push(yield* decodeItem(node));
      }
    }

    const { hasNextPage, endCursor } = page.search.pageInfo;

    after = hasNextPage && found.length < maxPerSearch ? endCursor : null;
  } while (after !== null);

  return found;
});

/** Whether an author is a bot, such as Renovate or a CI app. */
const isBot = (author: typeof Author.Type) =>
  author === null ||
  author.__typename === "Bot" ||
  /\[bot\]$/i.test(author.login);

const time = (value: string | null | undefined) => Date.parse(value ?? "") || 0;

const same = (a: string | undefined, b: string) =>
  a !== undefined && a.toLowerCase() === b.toLowerCase();

/** What's known of an item before its notification and base are read. */
interface Read {
  readonly item: Omit<Domain.AttentionFound, "work" | "fingerprint">;
  /** For your own open pull request: what to compare its base with. */
  readonly base: {
    readonly head: string;
    readonly branch: string;
  } | null;
}

/**
 * A pull request or issue's signals and who acted last, from the person
 * Upkeep works for's point of view. Most signals only come up on their own
 * items; a review request comes up on anyone's.
 */
export const read = (
  node: Pull | Issue,
  you: string,
  reviewRequested: boolean,
): Read => {
  const yours = same(node.author?.login, you);
  const signals: Array<Domain.Signal> = [];

  const signal = (kind: Domain.SignalKind, detail: string | null = null) =>
    signals.push({ kind, detail });

  const comment = node.comments.nodes.at(-1) ?? null;

  const events = [
    ...(comment === null || isBot(comment.author)
      ? []
      : [
          {
            who: comment.author?.login,
            at: time(comment.createdAt),
            comment: true,
          },
        ]),
    ...(node.__typename === "PullRequest"
      ? node.latestReviews.nodes.flatMap((review) =>
          review === null || isBot(review.author)
            ? []
            : [
                {
                  who: review.author?.login,
                  at: time(review.submittedAt),
                  comment: false,
                },
              ],
        )
      : []),
  ].sort((a, b) => b.at - a.at);

  const last = events[0];

  const lastCommit =
    node.__typename === "PullRequest"
      ? (node.commits.nodes.at(-1)?.commit ?? null)
      : null;

  const activityAt = Math.max(
    time(node.createdAt),
    last?.at ?? 0,
    yours ? time(lastCommit?.committedDate) : 0,
  );

  if (yours && last !== undefined && last.comment && !same(last.who, you))
    signal("new-comment", last.who ?? null);

  let base: Read["base"] = null;

  if (node.__typename === "PullRequest") {
    const requested =
      reviewRequested ||
      node.reviewRequests.nodes.some((request) =>
        same(request?.requestedReviewer?.login, you),
      );

    if (requested && !yours) signal("review-requested");

    if (node.isDraft) signal("draft");

    if (yours) {
      if (node.reviewDecision === "CHANGES_REQUESTED")
        signal("changes-requested");

      if (node.reviewDecision === "APPROVED") signal("approved");

      const unresolved = node.reviewThreads.nodes.filter((thread) => {
        const author = thread?.comments.nodes.at(-1)?.author ?? null;

        return (
          thread !== null &&
          !thread.isResolved &&
          !isBot(author) &&
          !same(author?.login, you)
        );
      }).length;

      if (unresolved > 0) signal("unresolved", String(unresolved));

      const checks = lastCommit?.statusCheckRollup?.state;

      if (checks === "FAILURE" || checks === "ERROR") signal("failing-checks");

      if (node.mergeable === "CONFLICTING") signal("conflicts");
      else base = { head: node.headRefOid, branch: node.baseRefName };
    }
  }

  return {
    item: {
      url: node.url,
      kind: node.__typename === "PullRequest" ? "pull" : "issue",
      repo: node.repository.nameWithOwner,
      number: node.number,
      title: node.title,
      author: node.author?.login ?? null,
      yours,
      youActedLast: last === undefined ? yours : same(last.who, you),
      involved: node.participants.nodes.some(
        (person) =>
          person !== null &&
          !same(person.login, node.author?.login ?? "") &&
          !/\[bot\]$/i.test(person.login),
      ),
      activityAt,
      updatedAt: time(node.updatedAt),
      signals,
      notification: null,
    },
    base,
  };
};

const Thread = Schema.Struct({
  id: Schema.String,
  reason: Schema.String,
  unread: Schema.Boolean,
  updated_at: Schema.String,
  subject: Schema.Struct({
    title: Schema.String,
    url: Schema.NullOr(Schema.String),
    type: Schema.String,
  }),
  repository: Schema.Struct({ full_name: Schema.String }),
});

type Thread = typeof Thread.Type;

/**
 * A notification's page: its pull request or issue, or for anything else,
 * such as a release, the repository's notifications with the thread's ID, so
 * each thread is still its own item.
 */
export const pageOf = (thread: Thread) => {
  const api = `https://api.github.com/repos/${thread.repository.full_name}/`;
  const url = thread.subject.url ?? "";
  const repo = `https://github.com/${thread.repository.full_name}`;

  if (url.startsWith(`${api}pulls/`))
    return `${repo}/pull/${url.slice(`${api}pulls/`.length)}`;

  if (url.startsWith(`${api}issues/`))
    return `${repo}/issues/${url.slice(`${api}issues/`.length)}`;

  return `https://github.com/notifications?query=repo%3A${thread.repository.full_name}#${thread.id}`;
};

/** Signals a notification's reason gives. */
const notificationSignals = (thread: Thread): Array<Domain.Signal> => [
  ...(thread.unread ? [{ kind: "unread" as const, detail: null }] : []),
  ...(thread.reason === "mention" || thread.reason === "team_mention"
    ? [{ kind: "mentioned" as const, detail: null }]
    : []),
  ...(thread.reason === "review_requested"
    ? [{ kind: "review-requested" as const, detail: null }]
    : []),
];

/**
 * Whether a URL is on one of these sites: `host/path` matches that path and
 * anything under it, `*.host` any subdomain of it.
 */
export const onSite = (url: string, sites: ReadonlyArray<string>) => {
  const bare = url.replace(/^https?:\/\//, "").toLowerCase();
  const host = bare.split("/")[0] ?? "";

  return sites.some((site) => {
    const pattern = site.toLowerCase();

    if (pattern.startsWith("*.")) {
      const domain = pattern.slice(2);

      return host === domain || host.endsWith(`.${domain}`);
    }

    return (
      bare === pattern ||
      bare.startsWith(`${pattern}/`) ||
      bare.startsWith(`${pattern}#`) ||
      bare.startsWith(`${pattern}?`)
    );
  });
};

const Compare = Schema.Struct({
  ahead_by: Schema.Int,
  files: Schema.optionalKey(
    Schema.Array(Schema.Struct({ filename: Schema.String })),
  ),
});

const Files = Schema.Array(Schema.Struct({ filename: Schema.String }));

/**
 * The files the base branch changed since a pull request's head that the
 * pull request also touches. Both reads are conditional, so an unmoved base
 * costs nothing.
 */
const baseOverlap = Effect.fnUntraced(function* (
  kept: Kept.Kept,
  repo: string,
  number: number,
  base: NonNullable<Read["base"]>,
) {
  const compare = yield* kept
    .get({ endpoint: `repos/${repo}/compare/${base.head}...${base.branch}` })
    .pipe(
      Effect.flatMap(({ value }) => Schema.decodeUnknownEffect(Compare)(value)),
    );

  if (compare.ahead_by === 0) return [];

  const moved = new Set((compare.files ?? []).map((file) => file.filename));

  const touched = yield* kept
    .get({
      endpoint: `repos/${repo}/pulls/${number}/files`,
      query: { per_page: 100 },
    })
    .pipe(
      Effect.flatMap(({ value }) => Schema.decodeUnknownEffect(Files)(value)),
    );

  return touched.map((file) => file.filename).filter((name) => moved.has(name));
});

/** Whether it's work time, from the configured check, or null without one. */
const workTimeOf = Effect.fnUntraced(function* (
  settings: Settings.Attention | undefined,
) {
  const [program, ...args] = settings?.workTime?.command ?? [];

  if (program === undefined) return null;

  return yield* run(program, args, { cwd: homedir(), trusted: homedir() }).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ work: Schema.Boolean })),
      ),
    ),
    Effect.map(({ work }) => work),
    Effect.catchCause((cause) =>
      RunLog.warn(
        `Couldn't tell whether it's work time: ${reason(cause)}`,
      ).pipe(Effect.as(null)),
    ),
  );
});

/** Repositories as `repo:` qualifiers, in searches short enough for GitHub. */
export const repoSearches = (repos: ReadonlyArray<string>, prefix: string) => {
  const searches: Array<string> = [];
  let current = prefix;

  for (const repo of repos) {
    const next = `${current} repo:${repo}`;

    if (next.length > 250 && current !== prefix) {
      searches.push(current);
      current = `${prefix} repo:${repo}`;
    } else current = next;
  }

  if (current !== prefix) searches.push(current);

  return searches;
};

const User = Schema.Struct({ login: Schema.String });

export const attention = Effect.fnUntraced(function* () {
  const reporter = yield* Reporter;
  const settings = (yield* Settings.load()).attention;
  const staleDays = settings?.staleDays ?? 14;
  const now = yield* Clock.currentTimeMillis;
  const kept = yield* Kept.make("attention");
  const { login } = yield* Api.json({ endpoint: "user", method: "GET" }, User);
  const repos = yield* reporter.repos();

  const since = new Date(now - staleDays * day).toISOString().slice(0, 10);

  const searches = [
    { q: "is:open involves:@me archived:false", reviews: false },
    { q: "is:open is:pr review-requested:@me archived:false", reviews: true },
    ...repoSearches(repos, "is:open archived:false").map((q) => ({
      q,
      reviews: false,
    })),
    ...(settings?.searches ?? []).map((q) => ({
      q: q.replaceAll("{since}", since),
      reviews: false,
    })),
  ];

  let complete = true;
  const found = new Map<string, Read>();

  for (const search of searches) {
    const nodes = yield* searchAll(search.q).pipe(
      Effect.catchCause((cause) =>
        RunLog.warn(`Couldn't search ${search.q}: ${reason(cause)}`).pipe(
          Effect.andThen(
            Effect.sync(() => {
              complete = false;
            }),
          ),
          Effect.as([]),
        ),
      ),
    );

    for (const node of nodes) {
      // A review request found once stays, whichever search finds it again
      const earlier = found.get(node.url);

      const reviews =
        search.reviews ||
        (earlier?.item.signals.some((s) => s.kind === "review-requested") ??
          false);

      found.set(node.url, read(node, login, reviews));
    }
  }

  yield* RunLog.info(
    `Found ${found.size} pull requests and issues in ${searches.length} searches`,
  );

  // Your own pull requests whose base moved under files they touch
  const bases = [...found.values()]
    .filter((entry) => entry.base !== null && entry.item.number !== null)
    .sort((a, b) => b.item.updatedAt - a.item.updatedAt)
    .slice(0, maxBaseChecks);

  yield* Effect.forEach(
    bases,
    (entry) =>
      baseOverlap(
        kept,
        entry.item.repo,
        entry.item.number ?? 0,
        entry.base ?? { head: "", branch: "" },
      ).pipe(
        Effect.map((files) => {
          if (files.length === 0) return;

          found.set(entry.item.url, {
            ...entry,
            item: {
              ...entry.item,
              signals: [
                ...entry.item.signals,
                {
                  kind: "base-moved",
                  detail: `${files.length} file${files.length === 1 ? "" : "s"}`,
                },
              ],
            },
          });
        }),
        Effect.catchCause((cause) =>
          RunLog.warn(
            `${entry.item.repo}#${entry.item.number}: couldn't compare with its base: ${reason(cause)}`,
          ),
        ),
      ),
    { concurrency: 4, discard: true },
  );

  // Unread notifications join their item, or stand as their own
  const threads = yield* kept
    .get({ endpoint: "notifications", query: { per_page: 50 } })
    .pipe(
      Effect.flatMap(({ value }) =>
        Schema.decodeUnknownEffect(Schema.Array(Thread))(value),
      ),
      Effect.catchCause((cause) =>
        RunLog.warn(`Couldn't read notifications: ${reason(cause)}`).pipe(
          Effect.andThen(
            Effect.sync(() => {
              complete = false;
            }),
          ),
          Effect.as([]),
        ),
      ),
    );

  for (const thread of threads) {
    const url = pageOf(thread);

    const notification = {
      id: thread.id,
      reason: thread.reason,
      unread: thread.unread,
      updatedAt: time(thread.updated_at),
    };

    const extra = notificationSignals(thread);
    const earlier = found.get(url);

    if (earlier !== undefined) {
      const kinds = new Set(earlier.item.signals.map((s) => s.kind));

      found.set(url, {
        ...earlier,
        item: {
          ...earlier.item,
          notification,
          signals: [
            ...earlier.item.signals,
            ...extra.filter((s) => !kinds.has(s.kind)),
          ],
        },
      });

      continue;
    }

    found.set(url, {
      item: {
        url,
        kind: "notification",
        repo: thread.repository.full_name,
        number: null,
        title: thread.subject.title,
        author: null,
        yours: false,
        youActedLast: false,
        involved: true,
        activityAt: notification.updatedAt,
        updatedAt: notification.updatedAt,
        signals: extra,
        notification,
      },
      base: null,
    });
  }

  // A notification's page can be the repository's notifications, so its
  // repository's own page is matched too
  const matches = (
    item: Read["item"],
    sites: ReadonlyArray<string> | undefined,
  ) =>
    onSite(item.url, sites ?? []) ||
    onSite(`https://github.com/${item.repo}`, sites ?? []);

  const items = [...found.values()].flatMap(
    ({ item }): Array<Domain.AttentionFound> =>
      matches(item, settings?.exclude)
        ? []
        : [
            {
              ...item,
              work: matches(item, settings?.work),
              // Everything that decides its section, so a move is kept
              fingerprint: JSON.stringify([
                item.updatedAt,
                item.title,
                item.involved,
                item.youActedLast,
                item.signals,
                item.notification?.updatedAt ?? null,
              ]),
            },
          ],
  );

  const result = yield* reporter.attention({
    items,
    complete,
    workTime: yield* workTimeOf(settings),
    staleDays,
  });

  yield* summary(
    `${items.length} items: ${result.added} new, ${result.changed} changed, ${result.gone} gone${complete ? "" : ", some searches failed"}`,
  );
}, Effect.scoped);
