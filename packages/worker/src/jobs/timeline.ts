/**
 * The timeline job: read what happened on GitHub for the Activity page.
 * Everyone's issues, pull requests, reviews, comments and releases come from
 * each tracked repository's events, yours anywhere from your own events, and
 * others' reviews and comments on your issues and pull requests outside the
 * tracked repositories from their timelines. Commits in tracked repositories
 * come from the watch job, which already reads them. Since October 2025 the
 * Events API leaves out a pull request's title and state and a push's
 * commits, so each issue or pull request is read once a run for its subject,
 * and a push outside the tracked repositories is compared once for its
 * commits. Every read is conditional, so what hasn't changed costs nothing.
 */
import { Api } from "@timmo001/effect-gh";
import type { Domain } from "@upkeep/api";
import { Clock, Effect, Option, Schema } from "effect";
import { reason } from "../Failure";
import * as GitHubApp from "../GitHubApp";
import * as Kept from "../Kept";
import { Reporter, summary } from "../Reporter";
import * as RunLog from "../RunLog";

/** How far back the search for your issues and pull requests looks. */
const lookbackDays = 7;

const Login = Schema.Struct({ login: Schema.String });

export const Event = Schema.Struct({
  type: Schema.String,
  actor: Schema.NullOr(Login),
  repo: Schema.Struct({ name: Schema.String }),
  created_at: Schema.String,
  payload: Schema.Unknown,
});

export type Event = typeof Event.Type;

const Numbered = Schema.Struct({ number: Schema.Int });

const IssuesPayload = Schema.Struct({
  action: Schema.String,
  issue: Schema.Struct({
    number: Schema.Int,
    title: Schema.String,
    html_url: Schema.String,
  }),
});

const PullPayload = Schema.Struct({
  action: Schema.String,
  number: Schema.Int,
});

const ReviewPayload = Schema.Struct({
  pull_request: Numbered,
  review: Schema.Struct({
    id: Schema.Number,
    state: Schema.String,
    body: Schema.NullOr(Schema.String),
    html_url: Schema.String,
  }),
});

const Comment = Schema.Struct({
  id: Schema.Number,
  body: Schema.String,
  html_url: Schema.String,
});

const CommentPayload = Schema.Struct({
  action: Schema.String,
  issue: Numbered,
  comment: Comment,
});

const ReviewCommentPayload = Schema.Struct({
  action: Schema.String,
  pull_request: Numbered,
  comment: Comment,
});

const ReleasePayload = Schema.Struct({
  action: Schema.String,
  release: Schema.Struct({
    tag_name: Schema.String,
    name: Schema.NullOr(Schema.String),
    html_url: Schema.String,
  }),
});

const PushPayload = Schema.Struct({
  ref: Schema.String,
  before: Schema.String,
  head: Schema.String,
});

/** An issue or pull request, as GitHub's issues API and search return it. */
export const Issue = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  html_url: Schema.String,
  user: Schema.NullOr(Login),
  pull_request: Schema.optionalKey(
    Schema.Struct({ merged_at: Schema.NullOr(Schema.String) }),
  ),
});

export type Issue = typeof Issue.Type;

/** One entry of an issue's or pull request's timeline. */
export const TimelineEvent = Schema.Struct({
  event: Schema.String,
  id: Schema.optionalKey(Schema.Number),
  actor: Schema.optionalKey(Schema.NullOr(Login)),
  user: Schema.optionalKey(Schema.NullOr(Login)),
  created_at: Schema.optionalKey(Schema.String),
  submitted_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  html_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
  state: Schema.optionalKey(Schema.String),
  comments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.Number,
        user: Schema.NullOr(Login),
        body: Schema.String,
        html_url: Schema.String,
        created_at: Schema.String,
      }),
    ),
  ),
});

export type TimelineEvent = typeof TimelineEvent.Type;

const decodeIssues = Schema.decodeUnknownOption(IssuesPayload);
const decodePull = Schema.decodeUnknownOption(PullPayload);
const decodeReview = Schema.decodeUnknownOption(ReviewPayload);
const decodeComment = Schema.decodeUnknownOption(CommentPayload);
const decodeReviewComment = Schema.decodeUnknownOption(ReviewCommentPayload);
const decodeRelease = Schema.decodeUnknownOption(ReleasePayload);
const decodePush = Schema.decodeUnknownOption(PushPayload);
const decodeEvent = Schema.decodeUnknownOption(Event);
const decodeTimelineEvent = Schema.decodeUnknownOption(TimelineEvent);
const decodeIssue = Schema.decodeUnknownEffect(Issue);

/** The opening, closing, merging and reopening the Activity page shows. */
const lifecycle = new Set(["opened", "closed", "merged", "reopened"]);

/**
 * A comment's or review's first line of text, without HTML comments,
 * headings or quote marks, as a title.
 */
export const firstLine = (body: string | null) =>
  (body ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(#+|>+)\s*/, "").trim())
    .find((line) => line !== "")
    ?.slice(0, 200) ?? "";

const time = (at: string) => Date.parse(at) || 0;

/** The ID of an opening, closing, merging or reopening, from any source. */
const lifecycleId = (
  kind: "issue" | "pull_request",
  repo: string,
  number: number,
  action: string,
  at: number,
) =>
  `${kind}:${repo.toLowerCase()}#${number}:${action}:${Math.floor(at / 1000)}`;

/** The issue or pull request an item is on, for its subject to be read. */
export interface Ref {
  readonly repo: string;
  readonly number: number;
}

/** An item from an event, waiting for its subject when it has a `ref`. */
export interface Found {
  readonly item: Omit<Domain.TimelineItem, "subject">;
  readonly ref: Ref | null;
}

const reviewAction = (state: string) => {
  switch (state.toLowerCase()) {
    case "approved":
      return "approved";
    case "changes_requested":
      return "requested changes";
    case "dismissed":
      return "dismissed a review";
    default:
      return "reviewed";
  }
};

/**
 * What an event says happened, if it's something the Activity page shows.
 * Pushes are left to {@link pushOf}.
 */
export const fromEvent = (event: Event): ReadonlyArray<Found> => {
  const repo = event.repo.name;
  const actor = event.actor?.login ?? null;
  const at = time(event.created_at);
  const base = { repo, actor, at };

  switch (event.type) {
    case "IssuesEvent":
      return Option.match(decodeIssues(event.payload), {
        onNone: () => [],
        onSome: ({ action, issue }) =>
          lifecycle.has(action)
            ? [
                {
                  item: {
                    ...base,
                    id: lifecycleId("issue", repo, issue.number, action, at),
                    kind: "issue",
                    action,
                    title: issue.title,
                    url: issue.html_url,
                  },
                  ref: { repo, number: issue.number },
                },
              ]
            : [],
      });
    case "PullRequestEvent":
      return Option.match(decodePull(event.payload), {
        onNone: () => [],
        onSome: ({ action, number }) =>
          lifecycle.has(action)
            ? [
                {
                  item: {
                    ...base,
                    id: lifecycleId("pull_request", repo, number, action, at),
                    kind: "pull_request",
                    action,
                    title: "",
                    url: `https://github.com/${repo}/pull/${number}`,
                  },
                  ref: { repo, number },
                },
              ]
            : [],
      });
    case "PullRequestReviewEvent":
      return Option.match(decodeReview(event.payload), {
        onNone: () => [],
        onSome: ({ pull_request, review }) => {
          const title = firstLine(review.body);

          // A review that only holds line comments says nothing of its own;
          // its comments come as events of their own
          if (review.state.toLowerCase() === "commented" && title === "")
            return [];

          return [
            {
              item: {
                ...base,
                id: `review:${review.id}`,
                kind: "review",
                action: reviewAction(review.state),
                title,
                url: review.html_url,
              },
              ref: { repo, number: pull_request.number },
            },
          ];
        },
      });
    case "IssueCommentEvent":
      return Option.match(decodeComment(event.payload), {
        onNone: () => [],
        onSome: ({ action, issue, comment }) =>
          action === "created"
            ? [
                {
                  item: {
                    ...base,
                    id: `comment:${comment.id}`,
                    kind: "comment",
                    action: "commented",
                    title: firstLine(comment.body),
                    url: comment.html_url,
                  },
                  ref: { repo, number: issue.number },
                },
              ]
            : [],
      });
    case "PullRequestReviewCommentEvent":
      return Option.match(decodeReviewComment(event.payload), {
        onNone: () => [],
        onSome: ({ action, pull_request, comment }) =>
          action === "created"
            ? [
                {
                  item: {
                    ...base,
                    id: `review-comment:${comment.id}`,
                    kind: "comment",
                    action: "commented on the code",
                    title: firstLine(comment.body),
                    url: comment.html_url,
                  },
                  ref: { repo, number: pull_request.number },
                },
              ]
            : [],
      });
    case "ReleaseEvent":
      return Option.match(decodeRelease(event.payload), {
        onNone: () => [],
        onSome: ({ action, release }) =>
          action === "published"
            ? [
                {
                  item: {
                    ...base,
                    id: `release:${repo.toLowerCase()}:${release.tag_name}`,
                    kind: "release",
                    action: "published",
                    title:
                      release.name === null || release.name.trim() === ""
                        ? release.tag_name
                        : release.name,
                    url: release.html_url,
                  },
                  ref: null,
                },
              ]
            : [],
      });
    default:
      return [];
  }
};

/** A push an event tells of, for its commits to be read. */
export interface Push {
  readonly id: string;
  readonly repo: string;
  readonly actor: string | null;
  readonly at: number;
  readonly branch: string;
  readonly before: string;
  readonly head: string;
}

/** The push an event tells of, if it's one. */
export const pushOf = (event: Event): Push | undefined => {
  if (event.type !== "PushEvent") return undefined;

  return Option.match(decodePush(event.payload), {
    onNone: () => undefined,
    onSome: ({ ref, before, head }) => ({
      id: `push:${event.repo.name.toLowerCase()}:${head}`,
      repo: event.repo.name,
      actor: event.actor?.login ?? null,
      at: time(event.created_at),
      branch: ref.replace(/^refs\/heads\//, ""),
      before,
      head,
    }),
  });
};

/** An issue or pull request as the subject that groups its activity. */
export const subjectOf = (
  repo: string,
  issue: Issue,
): Domain.TimelineSubject => ({
  key: `${repo.toLowerCase()}#${issue.number}`,
  kind: issue.pull_request === undefined ? "issue" : "pull_request",
  number: issue.number,
  title: issue.title,
  state:
    issue.pull_request?.merged_at !== undefined &&
    issue.pull_request.merged_at !== null
      ? "merged"
      : issue.state,
  author: issue.user?.login ?? null,
  url: issue.html_url,
});

/**
 * What an issue's or pull request's timeline says happened: its comments,
 * reviews, line comments and its closing, merging and reopening.
 */
export const fromTimelineEvent = (
  repo: string,
  subject: Domain.TimelineSubject,
  event: TimelineEvent,
): ReadonlyArray<Domain.TimelineItem> => {
  const base = { repo, subject };

  switch (event.event) {
    case "commented":
      return event.id === undefined || event.created_at === undefined
        ? []
        : [
            {
              ...base,
              id: `comment:${event.id}`,
              kind: "comment",
              action: "commented",
              actor: event.user?.login ?? event.actor?.login ?? null,
              at: time(event.created_at),
              title: firstLine(event.body ?? null),
              url: event.html_url ?? subject.url,
            },
          ];
    case "reviewed": {
      const title = firstLine(event.body ?? null);
      const state = event.state ?? "commented";

      if (
        event.id === undefined ||
        (state.toLowerCase() === "commented" && title === "")
      )
        return [];

      return [
        {
          ...base,
          id: `review:${event.id}`,
          kind: "review",
          action: reviewAction(state),
          actor: event.user?.login ?? null,
          at: time(event.submitted_at ?? event.created_at ?? ""),
          title,
          url: event.html_url ?? subject.url,
        },
      ];
    }

    case "line-commented":
      return (event.comments ?? []).map((comment) => ({
        ...base,
        id: `review-comment:${comment.id}`,
        kind: "comment",
        action: "commented on the code",
        actor: comment.user?.login ?? null,
        at: time(comment.created_at),
        title: firstLine(comment.body),
        url: comment.html_url,
      }));
    case "closed":
    case "merged":
    case "reopened": {
      if (event.created_at === undefined) return [];

      const at = time(event.created_at);

      return [
        {
          ...base,
          id: lifecycleId(subject.kind, repo, subject.number, event.event, at),
          kind: subject.kind,
          action: event.event,
          actor: event.actor?.login ?? null,
          at,
          title: subject.title,
          url: subject.url,
        },
      ];
    }

    default:
      return [];
  }
};

const Compare = Schema.Struct({
  html_url: Schema.String,
  total_commits: Schema.Int,
  commits: Schema.Array(
    Schema.Struct({ commit: Schema.Struct({ message: Schema.String }) }),
  ),
});

const SingleCommit = Schema.Struct({
  html_url: Schema.String,
  commit: Schema.Struct({ message: Schema.String }),
});

const subjectLine = (message: string) => message.split("\n")[0] ?? "";

/**
 * A push as one item, titled by its newest commit. A push that starts a
 * branch has nothing to compare with, so only its head commit is read.
 */
const pushItem = (push: Push) =>
  Api.json(
    {
      endpoint: `repos/${push.repo}/compare/${push.before}...${push.head}`,
      method: "GET",
    },
    Compare,
  ).pipe(
    Effect.map(({ html_url, total_commits, commits }) => {
      const newest = subjectLine(commits.at(-1)?.commit.message ?? "");

      return {
        url: html_url,
        title:
          total_commits > 1
            ? `${newest} (and ${total_commits - 1} more)`
            : newest,
      };
    }),
    Effect.catchCause(() =>
      Api.json(
        { endpoint: `repos/${push.repo}/commits/${push.head}`, method: "GET" },
        SingleCommit,
      ).pipe(
        Effect.map(({ html_url, commit }) => ({
          url: html_url,
          title: subjectLine(commit.message),
        })),
      ),
    ),
    Effect.map(({ url, title }): Domain.TimelineItem => ({
      id: push.id,
      kind: "push",
      action: `pushed to ${push.branch}`,
      repo: push.repo,
      actor: push.actor,
      at: push.at,
      title,
      url,
      subject: null,
    })),
  );

const Found = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ ...Issue.fields, repository_url: Schema.String }),
  ),
});

/** The events a kept read lists, none when they haven't changed since. */
const eventsAt = Effect.fnUntraced(function* (
  kept: Kept.Kept,
  request: Kept.Request,
) {
  const { value, changed } = yield* kept.get(request);

  if (!changed || !Array.isArray(value)) return [];

  return value.flatMap((each) => Option.toArray(decodeEvent(each)));
});

export const timeline = Effect.fnUntraced(function* () {
  const reporter = yield* Reporter;
  const repos = yield* reporter.repos();
  const login = yield* GitHubApp.login;
  const now = yield* Clock.currentTimeMillis;
  const kept = yield* Kept.make("timeline", { onlyOnSuccess: true });
  const tracked = new Set(repos.map((repo) => repo.toLowerCase()));
  const failed: Array<string> = [];

  /** Read a source, or warn and read it in full again next run. */
  const orForget = <A, E, R>(
    request: Kept.Request,
    effect: Effect.Effect<ReadonlyArray<A>, E, R>,
  ) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        RunLog.warn(`${request.endpoint}: ${reason(cause)}`).pipe(
          Effect.andThen(kept.forget(request)),
          Effect.andThen(Effect.sync(() => failed.push(request.endpoint))),
          Effect.as<ReadonlyArray<A>>([]),
        ),
      ),
    );

  yield* RunLog.info(
    `Reading the events of ${repos.length} repositories and ${login}`,
  );

  // Everyone's, in the tracked repositories, then yours anywhere
  const sources: ReadonlyArray<Kept.Request> = [
    ...repos.map((repo) => ({
      endpoint: `repos/${repo}/events`,
      query: { per_page: 100 },
    })),
    { endpoint: `users/${login}/events`, query: { per_page: 100 } },
  ];

  const read = yield* Effect.forEach(
    sources,
    (request) =>
      orForget(
        request,
        eventsAt(kept, request).pipe(
          Effect.map((events) => events.map((event) => ({ request, event }))),
        ),
      ),
    { concurrency: 4 },
  );

  const events = read.flat();

  const found = events.flatMap(({ request, event }) =>
    fromEvent(event).map((each) => ({ ...each, request })),
  );

  // Each issue or pull request once, for the subject its items are grouped by
  const refs = new Map(
    found.flatMap(({ ref }) =>
      ref === null ? [] : [[`${ref.repo.toLowerCase()}#${ref.number}`, ref]],
    ),
  );

  const subjects = new Map(
    yield* Effect.forEach(
      refs,
      ([key, ref]) =>
        kept.get({ endpoint: `repos/${ref.repo}/issues/${ref.number}` }).pipe(
          Effect.flatMap(({ value }) => decodeIssue(value)),
          Effect.map((issue) => [[key, subjectOf(ref.repo, issue)] as const]),
          Effect.catchCause((cause) =>
            RunLog.warn(`${key}: ${reason(cause)}`).pipe(Effect.as([])),
          ),
        ),
      { concurrency: 4 },
    ).pipe(Effect.map((each) => each.flat())),
  );

  // An item whose subject couldn't be read is left for the next run
  const fromSources: Array<Domain.TimelineItem> = [];

  for (const { item, ref, request } of found) {
    if (ref === null) {
      fromSources.push({ ...item, subject: null });
      continue;
    }

    const subject = subjects.get(`${ref.repo.toLowerCase()}#${ref.number}`);

    if (subject === undefined) {
      yield* kept.forget(request);
      continue;
    }

    fromSources.push({
      ...item,
      title: item.title === "" ? subject.title : item.title,
      subject,
    });
  }

  // Your pushes outside the tracked repositories, whose commits watch doesn't
  // read, compared once each
  const pushes = events.flatMap(({ request, event }) => {
    const push = pushOf(event);

    return push === undefined || tracked.has(push.repo.toLowerCase())
      ? []
      : [{ request, push }];
  });

  const knownPushes = new Set(
    yield* reporter.timelineKnown(pushes.map(({ push }) => push.id)),
  );

  const pushItems = yield* Effect.forEach(
    pushes.filter(({ push }) => !knownPushes.has(push.id)),
    ({ request, push }) =>
      pushItem(push).pipe(
        Effect.map((item) => [item]),
        Effect.catchCause((cause) =>
          RunLog.warn(
            `${push.repo}: couldn't read the push of ${push.head.slice(0, 7)}: ${reason(cause)}`,
          ).pipe(Effect.andThen(kept.forget(request)), Effect.as([])),
        ),
      ),
    { concurrency: 4 },
  );

  // Others' activity on your issues and pull requests outside the tracked
  // repositories, from the timelines of those that changed
  const since = new Date(now - lookbackDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const prefix = "https://api.github.com/repos/";

  const yours = (yield* Api.json(
    {
      endpoint: "search/issues",
      method: "GET",
      query: { q: `author:${login} updated:>=${since}`, per_page: 100 },
    },
    Found,
  )).items
    .map((issue) => ({
      repo: issue.repository_url.slice(prefix.length),
      issue,
    }))
    .filter(({ repo }) => !tracked.has(repo.toLowerCase()));

  const onYours = yield* Effect.forEach(
    yours,
    ({ repo, issue }) => {
      const request = { endpoint: `repos/${repo}/issues/${issue.number}` };

      return orForget(
        request,
        Effect.gen(function* () {
          const { changed } = yield* kept.get(request);

          if (!changed) return [];

          const subject = subjectOf(repo, issue);

          const pages = yield* Api.pages(
            {
              endpoint: `repos/${repo}/issues/${issue.number}/timeline`,
              method: "GET",
              query: { per_page: 100 },
            },
            Schema.Array(Schema.Unknown),
          );

          return pages
            .flat()
            .flatMap((each) => Option.toArray(decodeTimelineEvent(each)))
            .flatMap((event) => fromTimelineEvent(repo, subject, event))
            .filter(
              (item) => item.actor?.toLowerCase() !== login.toLowerCase(),
            );
        }),
      );
    },
    { concurrency: 4 },
  );

  const items = [...fromSources, ...pushItems.flat(), ...onYours.flat()];
  const added = yield* reporter.timeline(login, items);

  yield* summary(
    `Added ${added} of ${items.length} items to Activity${failed.length > 0 ? `, couldn't read ${failed.length} sources` : ""}`,
  );

  if (sources.length > 0 && failed.length >= sources.length) {
    return yield* new TimelineFailed({ count: failed.length });
  }
}, Effect.scoped);

class TimelineFailed extends Schema.TaggedError<TimelineFailed>()(
  "TimelineFailed",
  { count: Schema.Number },
) {
  override get message() {
    return `Couldn't read the events of any of the ${this.count} sources`;
  }
}
