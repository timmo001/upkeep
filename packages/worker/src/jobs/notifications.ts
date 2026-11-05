/**
 * The notifications job: dismiss unread GitHub notifications for dependency
 * updates that have merged, since GitHub can't switch them off, in the
 * repositories tracked for it. Each run logs
 * what it dismissed and what it couldn't check, and anything else is left
 * unread for a person.
 */
import { Api } from "@timmo001/effect-gh";
import { Catalogue } from "@upkeep/api";
import { Effect, Schema } from "effect";
import { pretty } from "../Failure";
import { summary, trackedFor } from "../Reporter";
import * as RunLog from "../RunLog";

const Thread = Schema.Struct({
  id: Schema.String,
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

const PullRequest = Schema.Struct({
  merged: Schema.Boolean,
  draft: Schema.Boolean,
  user: Schema.Struct({ login: Schema.String }),
  head: Schema.Struct({ ref: Schema.String }),
});

const bots = new Set(["renovate[bot]", "dependabot[bot]", "renovate"]);

/**
 * Whether a pull request is a merged dependency update: opened by Renovate or
 * Dependabot, or from one of their branches, but not Renovate's onboarding.
 */
export const settled = (pr: typeof PullRequest.Type) =>
  pr.merged &&
  !pr.draft &&
  pr.head.ref !== "renovate/configure" &&
  (bots.has(pr.user.login.toLowerCase()) ||
    pr.head.ref.startsWith("renovate/") ||
    pr.head.ref.startsWith("dependabot/"));

const label = (thread: Thread) =>
  `${thread.repository.full_name}: ${thread.subject.title}`;

/**
 * Dismiss one thread when its pull request is a merged dependency update.
 * The thread is read again just before, and left when it has changed since,
 * so a new comment is never dismissed with it.
 */
const review = Effect.fnUntraced(function* (thread: Thread) {
  const url = thread.subject.url ?? "";
  const prefix = "https://api.github.com/";

  if (!url.startsWith(`${prefix}repos/${thread.repository.full_name}/pulls/`))
    return "left" as const;

  const pr = yield* Api.json(
    { endpoint: url.slice(prefix.length), method: "GET" },
    PullRequest,
  );

  if (!settled(pr)) return "left" as const;

  const endpoint = `notifications/threads/${thread.id}`;
  const current = yield* Api.json({ endpoint, method: "GET" }, Thread);

  if (!current.unread || current.updated_at !== thread.updated_at) {
    yield* RunLog.info(`${label(thread)}: changed since, so left`);

    return "left" as const;
  }

  yield* Api.empty({ endpoint, method: "DELETE" });
  yield* RunLog.info(`${label(thread)}: dismissed`);

  return "dismissed" as const;
});

class NotificationsUnchecked extends Schema.TaggedError<NotificationsUnchecked>()(
  "NotificationsUnchecked",
  { count: Schema.Number },
) {
  override get message() {
    return `Couldn't check ${this.count} notification${this.count === 1 ? "" : "s"}`;
  }
}

/**
 * Review every unread pull request notification. One that can't be checked
 * is logged and the rest carry on; the run fails at the end, counting them.
 */
export const notifications = Effect.fnUntraced(function* () {
  const tracked = yield* trackedFor(Catalogue.notifications.id);

  const pages = yield* Api.pages(
    { endpoint: "notifications", method: "GET", query: { per_page: 100 } },
    Schema.Array(Thread),
  );

  const threads = pages
    .flat()
    .filter(
      (thread) =>
        thread.unread &&
        thread.subject.type === "PullRequest" &&
        tracked(thread.repository.full_name),
    );

  let dismissed = 0;
  let unchecked = 0;

  for (const thread of threads) {
    const outcome = yield* review(thread).pipe(
      Effect.catchCause((cause) =>
        RunLog.warn(`${label(thread)}: couldn't check: ${pretty(cause)}`).pipe(
          Effect.as("unchecked" as const),
        ),
      ),
    );

    if (outcome === "dismissed") dismissed += 1;

    if (outcome === "unchecked") unchecked += 1;
  }

  yield* summary(
    `Dismissed ${dismissed} of ${threads.length} unread pull request notifications${unchecked > 0 ? `, ${unchecked} couldn't be checked` : ""}`,
  );

  if (unchecked > 0)
    return yield* new NotificationsUnchecked({ count: unchecked });
});
