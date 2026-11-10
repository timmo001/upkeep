/**
 * How the timeline job reads GitHub's events and timelines into Activity
 * items, with IDs that come out the same whichever source found them.
 */
import { expect, test } from "bun:test";
import {
  type Event,
  firstLine,
  fromEvent,
  fromTimelineEvent,
  pushOf,
  subjectOf,
} from "./timeline";

const at = "2026-11-10T12:00:00Z";

const event = (type: string, payload: Event["payload"]): Event => ({
  type,
  actor: { login: "someone" },
  repo: { name: "Owner/Repo" },
  created_at: at,
  payload,
});

const pull = subjectOf("Owner/Repo", {
  number: 7,
  title: "Fix the thing",
  state: "closed",
  html_url: "https://github.com/Owner/Repo/pull/7",
  user: { login: "author" },
  pull_request: { merged_at: at },
});

test("a merged pull request is its subject's state, keyed in lower case", () => {
  expect(pull).toMatchObject({
    key: "owner/repo#7",
    kind: "pull_request",
    state: "merged",
    author: "author",
  });
});

test("a pull request's merge has the same ID from its event and its timeline", () => {
  const [found] = fromEvent(
    event("PullRequestEvent", { action: "merged", number: 7 }),
  );

  const [fromTimeline] = fromTimelineEvent("Owner/Repo", pull, {
    event: "merged",
    actor: { login: "someone" },
    created_at: at,
  });

  expect(found?.item).toMatchObject({
    kind: "pull_request",
    action: "merged",
    title: "",
  });
  expect(found?.ref).toEqual({ repo: "Owner/Repo", number: 7 });
  expect(found?.item.id).toBe(fromTimeline?.id);
});

test("a comment has the same ID from its event and its timeline", () => {
  const [found] = fromEvent(
    event("IssueCommentEvent", {
      action: "created",
      issue: { number: 7 },
      comment: {
        id: 42,
        body: "<!-- bot -->\n## Looks good\nMore",
        html_url: "https://github.com/Owner/Repo/pull/7#issuecomment-42",
      },
    }),
  );

  const [fromTimeline] = fromTimelineEvent("Owner/Repo", pull, {
    event: "commented",
    id: 42,
    user: { login: "someone" },
    created_at: at,
    body: "Looks good",
  });

  expect(found?.item).toMatchObject({
    id: "comment:42",
    kind: "comment",
    title: "Looks good",
  });
  expect(fromTimeline?.id).toBe("comment:42");
});

test("a review with only line comments is left to its comments", () => {
  const review = (state: string, body: string | null) =>
    fromEvent(
      event("PullRequestReviewEvent", {
        pull_request: { number: 7 },
        review: { id: 9, state, body, html_url: "https://github.com/x" },
      }),
    );

  expect(review("commented", null)).toEqual([]);
  expect(review("approved", null)[0]?.item).toMatchObject({
    id: "review:9",
    kind: "review",
    action: "approved",
  });
});

test("a release stands alone, titled by its tag when it has no name", () => {
  const [found] = fromEvent(
    event("ReleaseEvent", {
      action: "published",
      release: {
        tag_name: "v1.2.0",
        name: "",
        html_url: "https://github.com/x",
      },
    }),
  );

  expect(found?.ref).toBeNull();
  expect(found?.item).toMatchObject({
    id: "release:owner/repo:v1.2.0",
    title: "v1.2.0",
  });
});

test("a push is read for its branch, and nothing else of it is an item", () => {
  const push = event("PushEvent", {
    ref: "refs/heads/main",
    before: "aaa",
    head: "bbb",
  });

  expect(fromEvent(push)).toEqual([]);
  expect(pushOf(push)).toMatchObject({
    id: "push:owner/repo:bbb",
    branch: "main",
  });
});

test("a first line skips quotes and blank lines and is cut short", () => {
  expect(firstLine("\n> quoted\nrest")).toBe("quoted");
  expect(firstLine(null)).toBe("");
  expect(firstLine("x".repeat(300))).toHaveLength(200);
});
