/** The run lifecycle rules the server relies on, against an in-memory store. */
import { BunServices } from "@effect/platform-bun";
import type { Domain } from "@upkeep/api";
import { expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { Store } from "./Store";

const run = <A, E>(effect: Effect.Effect<A, E, Store>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Store.layerFile(":memory:")),
      Effect.provide(BunServices.layer),
    ),
  );

const found = (
  number: number,
  signals: ReadonlyArray<Domain.Signal> = [],
  notification: Domain.AttentionNotification | null = null,
  issue?: { readonly labels: ReadonlyArray<string>; readonly at: number },
): Domain.AttentionFound => ({
  url: `https://github.com/timmo001/a/pull/${number}`,
  kind: issue === undefined ? "pull" : "issue",
  repo: "timmo001/a",
  number,
  title: `Pull ${number}`,
  author: "timmo001",
  yours: true,
  work: false,
  youActedLast: true,
  // An issue nobody else joined, so only its labels keep it out of the backlog
  involved: issue === undefined,
  activityAt: issue?.at ?? 0,
  updatedAt: 0,
  signals,
  labels: issue?.labels ?? [],
  notification,
  fingerprint: JSON.stringify(signals),
});

test("status labels move your own items between sections, and fill in quietly", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;
      const now = Date.now();

      const issue = (number: number, labels: ReadonlyArray<string>) =>
        found(number, [], null, { labels, at: now });

      // An older worker sent no labels; the next collection fills them in
      yield* store.recordAttention(
        snapshot([issue(1, []), issue(2, []), issue(3, []), issue(4, [])]),
      );

      yield* store.recordAttention(
        snapshot([
          issue(1, ["Needs Decision"]),
          issue(2, ["blocked"]),
          issue(3, ["In Progress", "Bug"]),
          issue(4, ["On Hold"]),
        ]),
      );

      const page = yield* store.attention();

      expect(page.items.map((item) => [item.number, item.section])).toEqual(
        expect.arrayContaining([
          [1, "needs-you"],
          // Waiting on something else, with nothing to fix
          [2, "backlog"],
          [3, "waiting"],
          [4, "backlog"],
        ]),
      );

      expect(page.changes).toHaveLength(0);
    }),
  ));

const snapshot = (
  items: ReadonlyArray<Domain.AttentionFound>,
  complete = true,
) => ({ items, complete, workTime: null, staleDays: 14 });

test("attention only logs what moved, and drops items only when complete", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      const all = [found(1), found(2), found(3)];

      // Everything is new on the first collection, so none of it is logged
      yield* store.recordAttention(snapshot(all));
      expect((yield* store.attention()).changes).toHaveLength(0);

      const same = yield* store.recordAttention(snapshot(all));

      expect(same).toEqual({ added: 0, changed: 0, gone: 0 });

      // A partial collection keeps what it didn't find
      yield* store.recordAttention(snapshot([found(1)], false));
      expect((yield* store.attention()).items).toHaveLength(3);

      const moved = yield* store.recordAttention(
        snapshot([found(1, [{ kind: "failing-checks", detail: null }])]),
      );

      expect(moved).toEqual({ added: 0, changed: 1, gone: 2 });

      const page = yield* store.attention();

      expect(page.items.map((item) => [item.number, item.section])).toEqual([
        [1, "blocked"],
      ]);

      expect(
        page.changes.map((change) => [change.title, change.what, change.gone]),
      ).toEqual(
        expect.arrayContaining([
          ["Pull 1", ["New: failing checks"], false],
          ["Pull 2", ["Closed, or no longer involves you"], true],
          ["Pull 3", ["Closed, or no longer involves you"], true],
        ]),
      );
    }),
  ));

test("a hidden item stays hidden until it changes, and marking read settles its notification", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      const hiddenOf = (number: number) =>
        store
          .attention()
          .pipe(
            Effect.map(
              (page) =>
                page.items.find((item) => item.number === number)?.hidden,
            ),
          );

      const mentioned = found(
        2,
        [
          { kind: "unread", detail: null },
          { kind: "mentioned", detail: null },
        ],
        { id: "42", reason: "mention", unread: true, updatedAt: 0 },
      );

      yield* store.recordAttention(snapshot([found(1), mentioned]));
      yield* store.hideAttention(found(1).url, true);
      yield* store.recordAttention(snapshot([found(1), mentioned]));
      expect(yield* hiddenOf(1)).toBe(true);

      yield* store.recordAttention(
        snapshot([found(1, [{ kind: "conflicts", detail: null }]), mentioned]),
      );
      expect(yield* hiddenOf(1)).toBe(false);

      yield* store.markAttentionRead("42");

      const item = (yield* store.attention()).items.find(
        (each) => each.number === 2,
      );

      expect(item?.signals).toEqual([]);
      expect(item?.notification?.unread).toBe(false);
      expect(item?.section).toBe("stale");
      expect(item?.hidden).toBe(false);
    }),
  ));

test("an item sits in one group, and removing a group takes what's on it", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      const first = yield* store.createGroup({
        name: "Roadmap item",
        items: [found(1).url, found(2).url],
      });

      const second = yield* store.createGroup({
        name: "Docs",
        focus: "today",
        notes: "Before the release",
      });

      yield* store.linkAttention(found(2).url, second.id);
      yield* store.updateGroup(second.id, { notes: null });
      yield* store.addWait(second.id, { text: "Frontend demo release" });
      yield* store.commentAttention({ group: second.id, text: "Not stale" });
      yield* store.commentAttention({ url: found(1).url, text: "Mine" });

      const page = yield* store.attention();

      expect(
        page.groups.map((group) => [
          group.name,
          group.focus,
          group.notes,
          group.items.map((item) => item.url),
          group.waits.length,
        ]),
      ).toEqual([
        ["Roadmap item", "watching", null, [found(1).url], 0],
        ["Docs", "today", null, [found(2).url], 1],
      ]);

      yield* store.deleteGroup(second.id);

      const after = yield* store.attention();

      expect(after.groups.map((group) => group.id)).toEqual([first.id]);
      expect(after.comments.map((comment) => comment.text)).toEqual(["Mine"]);

      expect(
        yield* store.linkAttention(found(2).url, second.id).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        ),
      ).toBe("GroupNotFound");
    }),
  ));

test("the context agent's notes, answers and links land, and a gone item keeps its group", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      // Quiet since the epoch, so going stale until a note says otherwise
      yield* store.recordAttention(snapshot([found(1), found(2), found(3)]));

      const group = yield* store.createGroup({
        name: "Rollout",
        items: [found(3).url],
      });

      const comment = yield* store.commentAttention({
        url: found(1).url,
        text: "Never show me subscribed threads",
      });

      yield* store.recordContext({
        notes: [
          {
            url: found(1).url,
            text: "Waiting on the December release",
            recheckAt: Number.MAX_SAFE_INTEGER,
            fingerprint: found(1).fingerprint,
          },
        ],
        followUps: [{ group: "gone", text: "Skipped" }],
        comments: [
          {
            id: comment.id,
            outcome: "Kept as a rule",
            rule: "Skip subscribed threads",
          },
        ],
        links: [
          { url: found(2).url, group: group.id, suggested: true },
          // Already in the group, so the suggestion leaves it be
          { url: found(3).url, group: "gone", suggested: true },
        ],
      });

      const page = yield* store.attention();

      const item = (number: number) =>
        page.items.find((each) => each.number === number);

      expect([item(1)?.section, item(1)?.note?.text]).toEqual([
        "waiting",
        "Waiting on the December release",
      ]);
      expect(item(2)?.section).toBe("stale");
      expect(page.comments[0]?.outcome).toBe("Kept as a rule");
      expect(page.rules.map((rule) => rule.text)).toEqual([
        "Skip subscribed threads",
      ]);
      expect(page.groups.find((each) => each.id === group.id)?.items).toEqual([
        { url: found(3).url, source: "you", suggested: false },
        { url: found(2).url, source: "agent", suggested: true },
      ]);

      // Item 3 goes, and its change says which group it left
      yield* store.recordAttention(snapshot([found(1), found(2)]));

      const after = yield* store.attention();

      expect(
        after.changes.find((change) => change.url === found(3).url)?.group,
      ).toBe(group.id);
    }),
  ));

test("GitHub's links form groups that keep what you set as they change", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;
      const parent = "https://github.com/timmo001/a/issues/99";

      const withRelations = (
        items: ReadonlyArray<Domain.AttentionFound>,
        relations: ReadonlyArray<Domain.AttentionRelation>,
      ) => ({ ...snapshot(items), relations });

      // Two pull requests closing the same issue, which isn't an item itself
      yield* store.recordAttention(
        withRelations(
          [found(1), found(2), found(3)],
          [
            { from: found(1).url, to: parent },
            { from: found(2).url, to: parent },
          ],
        ),
      );

      const [formed] = (yield* store.attention()).groups;

      expect(formed?.items.map((item) => item.url)).toEqual([
        found(1).url,
        found(2).url,
      ]);
      expect(formed?.source).toBe("github");

      yield* store.updateGroup(formed?.id ?? "", { focus: "today" });

      // A third joins, and one you move by hand stays where you put it
      const mine = yield* store.createGroup({
        name: "Mine",
        items: [found(2).url],
      });

      yield* store.recordAttention(
        withRelations(
          [found(1), found(2), found(3)],
          [
            { from: found(1).url, to: parent },
            { from: found(2).url, to: parent },
            { from: found(3).url, to: found(1).url },
          ],
        ),
      );

      const groups = (yield* store.attention()).groups;

      expect(
        groups.map((group) => [
          group.id,
          group.focus,
          group.items.map((item) => item.url),
        ]),
      ).toEqual([
        [formed?.id ?? "", "today", [found(1).url, found(3).url]],
        [mine.id, "watching", [found(2).url]],
      ]);
    }),
  ));

test("a waiting run of the same job and release isn't queued twice", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;
      const release = { repo: "timmo001/a", tag: "v1", url: "" };

      const first = yield* store.queueRun({
        job: "bump",
        trigger: "release",
        release,
      });

      const again = yield* store.queueRun({
        job: "bump",
        trigger: "manual",
        release,
      });

      const other = yield* store.queueRun({
        job: "bump",
        trigger: "release",
        release: { ...release, tag: "v2" },
      });

      expect(again.id).toBe(first.id);
      expect(other.id).not.toBe(first.id);
    }),
  ));

test("a command for one worker waits for that one", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      yield* store.queueRun({
        job: "command",
        trigger: "manual",
        release: null,
        command: {
          kind: "start-agent",
          worker: "desktop",
          url: "https://github.com/owner/repo/pull/1",
          group: null,
          prompt: null,
        },
      });

      expect(Option.isNone(yield* store.claim(["command"], "laptop"))).toBe(
        true,
      );
      expect(Option.isSome(yield* store.claim(["command"], "desktop"))).toBe(
        true,
      );
    }),
  ));

test("only the worker running a run can report on it", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      yield* store.queueRun({
        job: "releases",
        trigger: "manual",
        release: null,
      });

      const claimed = yield* store.claim(["releases"], "desktop");

      expect(Option.isSome(claimed)).toBe(true);
      expect(Option.isNone(yield* store.claim(["releases"], "laptop"))).toBe(
        true,
      );

      const id = Option.getOrThrow(claimed).id;

      const error = yield* store
        .finish(id, "laptop", "failed", null)
        .pipe(Effect.flip);

      expect(error._tag).toBe("RunNotClaimed");

      yield* store.finish(id, "desktop", "succeeded", null);

      expect((yield* store.run(id)).state).toBe("succeeded");
    }),
  ));

test("a summary's period is kept through later reports", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      yield* store.queueRun({
        job: "summary",
        trigger: "manual",
        release: null,
      });

      const id = Option.getOrThrow(
        yield* store.claim(["summary"], "desktop"),
      ).id;

      expect((yield* store.run(id)).period).toBeNull();

      const period = { from: 1000, to: 2000, unread: true };

      yield* store.report(id, "desktop", { period });
      yield* store.report(id, "desktop", { summary: "Between ..." });

      expect((yield* store.run(id)).period).toEqual(period);
    }),
  ));

test("a lost or interrupted run is requeued once, then fails", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      const queued = yield* store.queueRun({
        job: "releases",
        trigger: "manual",
        release: null,
      });

      yield* store.claim(["releases"], "desktop");

      const lost = yield* store.failLost(Date.now() + 1);

      expect(lost.requeued.map((run) => run.state)).toEqual(["queued"]);
      expect(lost.failed).toEqual([]);

      yield* store.claim(["releases"], "laptop");

      expect(Option.isNone(yield* store.requeue(queued.id, "laptop"))).toBe(
        true,
      );

      const again = yield* store.failLost(Date.now() + 1);

      expect(again.requeued).toEqual([]);
      expect(again.failed.map((run) => run.state)).toEqual(["failed"]);
    }),
  ));

test("an interrupted run goes back to the front of the queue", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      const first = yield* store.queueRun({
        job: "releases",
        trigger: "manual",
        release: null,
      });

      yield* store.claim(["releases"], "desktop");

      yield* store.queueRun({
        job: "labels",
        trigger: "manual",
        release: null,
      });

      const requeued = yield* store.requeue(first.id, "desktop");

      expect(Option.getOrThrow(requeued).worker).toBeNull();

      const next = yield* store.claim(["releases", "labels"], "laptop");

      expect(Option.getOrThrow(next).id).toBe(first.id);
    }),
  ));

test("cancelling drops a queued run and stops a running one", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      const queued = yield* store.queueRun({
        job: "labels",
        trigger: "manual",
        release: null,
      });

      expect((yield* store.cancel(queued.id, "aidan")).dropped).toBe(true);
      expect((yield* store.run(queued.id).pipe(Effect.flip))._tag).toBe(
        "RunNotFound",
      );

      yield* store.queueRun({
        job: "releases",
        trigger: "manual",
        release: null,
      });

      const id = Option.getOrThrow(
        yield* store.claim(["releases"], "desktop"),
      ).id;

      const cancelled = yield* store.cancel(id, "aidan");

      expect(cancelled.dropped).toBe(false);
      expect(cancelled.run.state).toBe("cancelled");
      expect(cancelled.run.error).toBe("Cancelled by aidan");
      expect(
        (yield* store.heartbeat(id, "desktop").pipe(Effect.flip))._tag,
      ).toBe("RunNotClaimed");
      expect((yield* store.cancel(id, "aidan").pipe(Effect.flip))._tag).toBe(
        "RunFinished",
      );
    }),
  ));

test("a heal's record fills in as its worker reports", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      yield* store.queueRun({
        job: "heal",
        trigger: "heal",
        release: null,
        heal: {
          of: "failed-run",
          job: "bump",
          target: { kind: "consumer", repo: "timmo001/a" },
        },
      });

      const id = Option.getOrThrow(yield* store.claim(["heal"], "desktop")).id;

      yield* store.updateHeal(id, "desktop", {
        decision: "retry",
        reason: "A flaky network call",
        decidedBy: "cloudflare/clef",
        action: "Queued bump again",
      });
      yield* store.updateHeal(id, "desktop", { action: "Watched it pass" });

      const healed = yield* store.run(id);

      expect(healed.heal).toEqual({
        of: "failed-run",
        job: "bump",
        target: { kind: "consumer", repo: "timmo001/a" },
        decision: "retry",
        reason: "A flaky network call",
        decidedBy: "cloudflare/clef",
        model: null,
        variant: null,
        actions: ["Queued bump again", "Watched it pass"],
        commit: null,
        session: null,
        issue: null,
      });
      expect(
        yield* store.healsSince(
          "bump",
          { kind: "consumer", repo: "timmo001/a" },
          0,
        ),
      ).toBe(1);
      expect(
        yield* store.healsSince(
          "bump",
          { kind: "consumer", repo: "timmo001/b" },
          0,
        ),
      ).toBe(0);
      expect(yield* store.healsSince("labels", { kind: "upkeep" }, 0)).toBe(0);
    }),
  ));

test("dismissing a heal's entry or run clears what it needs", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      /** A finished heal of bump for `repo` that chose a fix and needs a person. */
      const needing = Effect.fnUntraced(function* (repo: string) {
        yield* store.queueRun({
          job: "heal",
          trigger: "heal",
          release: null,
          heal: {
            of: `failed-${repo}`,
            job: "bump",
            target: { kind: "consumer", repo },
          },
        });

        const id = Option.getOrThrow(
          yield* store.claim(["heal"], "desktop"),
        ).id;

        yield* store.updateHeal(id, "desktop", { decision: "fix" });
        yield* store.report(id, "desktop", { attention: true });
        yield* store.finish(id, "desktop", "succeeded", null);

        return id;
      });

      const first = yield* needing("timmo001/a");
      const second = yield* needing("timmo001/b");

      const needs = () =>
        store
          .inbox(0)
          .pipe(
            Effect.map(({ entries }) =>
              entries.filter((entry) => entry.kind === "needs"),
            ),
          );

      const [entry] = yield* needs();

      expect(entry?.run).toBe(second);

      yield* store.dismiss(entry?.id ?? "");

      expect((yield* store.run(first)).attention).toBe(false);
      expect((yield* store.run(second)).attention).toBe(false);

      const third = yield* needing("timmo001/c");

      expect((yield* needs()).length).toBe(1);

      const dismissed = yield* store.dismissRun(third);

      expect(dismissed.attention).toBe(false);
      expect(yield* needs()).toEqual([]);
    }),
  ));

test("a newer waiting heal replaces the older one for the same consumer", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      yield* store.wait("bump", "timmo001/a", "run-1", null);
      yield* store.wait("bump", "timmo001/A", "run-2", "issue-2");
      yield* store.wait("bump", "timmo001/b", "run-3", null);

      expect(
        (yield* store.waiting()).map(({ repo, run, issue }) => [
          repo,
          run,
          issue,
        ]),
      ).toEqual([
        ["timmo001/a", "run-2", "issue-2"],
        ["timmo001/b", "run-3", null],
      ]);
      expect(yield* store.stopWaiting("bump", "timmo001/a")).toBe(true);
      expect(yield* store.stopWaiting("bump", "timmo001/a")).toBe(false);
      expect((yield* store.waiting()).length).toBe(1);
    }),
  ));

test("a parked job stays parked until it's unparked", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      yield* store.park("bump", "Failed past its heals", null);

      expect((yield* store.parked()).get("bump")?.reason).toBe(
        "Failed past its heals",
      );
      expect(yield* store.unpark("bump")).toBe(true);
      expect(yield* store.unpark("bump")).toBe(false);
      expect((yield* store.parked()).size).toBe(0);
    }),
  ));

test("pruning keeps each job's latest runs and anything unfinished", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;
      const finished: Array<string> = [];

      for (let index = 0; index < 3; index++) {
        yield* store.queueRun({
          job: "releases",
          trigger: "manual",
          release: null,
        });

        const id = Option.getOrThrow(
          yield* store.claim(["releases"], "desktop"),
        ).id;

        yield* store.appendLog(id, "desktop", [
          { at: 0, level: "info", message: "ran" },
        ]);
        yield* store.finish(id, "desktop", "succeeded", null);
        finished.push(id);
      }

      const waiting = yield* store.queueRun({
        job: "releases",
        trigger: "manual",
        release: null,
      });

      expect(yield* store.prune(Number.MAX_SAFE_INTEGER, 1)).toBe(2);
      expect((yield* store.run(waiting.id)).state).toBe("queued");
      expect((yield* store.log(finished[2] ?? "", 0, 10)).length).toBe(1);

      for (const id of finished.slice(0, 2)) {
        expect((yield* store.run(id).pipe(Effect.flip))._tag).toBe(
          "RunNotFound",
        );
      }

      expect(yield* store.prune(0, 0)).toBe(0);
    }),
  ));

test("a repository's first release is only recorded", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;
      const v1 = { repo: "timmo001/a", tag: "v1", url: "" };

      expect(yield* store.recordReleases([v1])).toEqual([]);
      expect(yield* store.recordReleases([v1])).toEqual([]);

      const v2 = { ...v1, tag: "v2" };

      expect(yield* store.recordReleases([v2])).toEqual([v2]);
    }),
  ));

test("a release's bumps across repositories land in one inbox entry", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;
      const v1 = { repo: "timmo001/lib", tag: "v1", url: "" };
      const v2 = { ...v1, tag: "v2", url: "https://example.com/v2" };

      yield* store.recordReleases([v1]);
      yield* store.recordReleases([v2]);

      yield* store.queueRun({ job: "bump", trigger: "release", release: v2 });

      const id = Option.getOrThrow(yield* store.claim(["bump"], "desktop")).id;

      for (const repo of ["timmo001/a", "timmo001/b"]) {
        yield* store.report(id, "desktop", {
          change: {
            repo,
            sha: `${repo}-sha`,
            subject: "Update timmo001/lib to v2",
            url: "",
            at: 1,
          },
        });
      }

      const { entries } = yield* store.inbox(0);

      expect(entries).toHaveLength(1);
      expect(entries[0]?.kind).toBe("release");
      expect(entries[0]?.title).toBe("lib v2");
      expect(entries[0]?.url).toBe(v2.url);
      expect(entries[0]?.items.map((item) => item.repo)).toEqual([
        "timmo001/a",
        "timmo001/b",
      ]);
    }),
  ));

test("every version of the same update shares one inbox entry", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      const update = (sha: string, subject: string) => ({
        repo: "timmo001/a",
        sha,
        subject,
        url: "",
        at: 1,
        group: `update:${subject}`,
        title: subject,
        kind: "update" as const,
        routine: true,
      });

      yield* store.seen([
        update("a1", "Update Upkeep to 0.7.1 (#3)"),
        update("a2", "Update Upkeep to 0.7.2"),
        update("a3", "Update timmo001/checks digest to c0562b3"),
        update("a4", "Update timmo001/checks digest to 130f993"),
        update("a5", "Update github actions"),
      ]);

      const { entries } = yield* store.inbox(0);

      expect(
        entries
          .map((entry) => [entry.title, entry.items.length])
          .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual([
        ["Update github actions", 1],
        ["Update timmo001/checks", 2],
        ["Update Upkeep", 2],
      ]);
    }),
  ));

test("a run's commit replaces the same commit the watch job found", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;
      const commit = { repo: "timmo001/a", sha: "abc", url: "", at: 1 };

      expect(
        yield* store.seen([
          {
            ...commit,
            subject: "Update hk",
            group: "you:timmo001/a:2026-11-04",
            title: "Your commits to a",
            kind: "commit",
            you: true,
          },
        ]),
      ).toBe(1);
      expect(
        yield* store.known([
          { repo: "Timmo001/A", sha: "abc" },
          { repo: "timmo001/a", sha: "def" },
        ]),
      ).toEqual([{ repo: "Timmo001/A", sha: "abc" }]);

      yield* store.queueRun({ job: "drift", trigger: "manual", release: null });

      const id = Option.getOrThrow(yield* store.claim(["drift"], "desktop")).id;

      yield* store.report(id, "desktop", {
        change: { ...commit, subject: "Update jdx/hk to v1" },
      });

      const { entries } = yield* store.inbox(0);

      expect(entries.map((entry) => [entry.kind, entry.routine])).toEqual([
        ["drift", true],
      ]);
    }),
  ));

test("a held release keeps the latest per repository until it's taken", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;
      const v1 = { repo: "timmo001/lib", tag: "v1", url: "" };
      const other = { repo: "timmo001/app", tag: "v3", url: "" };

      yield* store.hold("bump", v1);
      yield* store.hold("bump", other);
      yield* store.hold("bump", { ...v1, repo: "Timmo001/Lib", tag: "v2" });
      yield* store.hold("drift", v1);

      expect(
        (yield* store.takeHeld("bump"))
          .map((release) => `${release.repo}@${release.tag}`)
          .toSorted(),
      ).toEqual(["timmo001/app@v3", "timmo001/lib@v2"]);
      expect(yield* store.takeHeld("bump")).toEqual([]);
      expect((yield* store.takeHeld("drift")).map((r) => r.tag)).toEqual([
        "v1",
      ]);
    }),
  ));

test("parking needs a person until the job is unparked", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      yield* store.park("bump", "It keeps failing", null);
      yield* store.park("bump", "It keeps failing", null);

      const [parked] = (yield* store.inbox(0)).entries;

      expect(parked?.kind).toBe("needs");
      expect(parked?.count).toBe(2);
      expect(parked?.job).toBe("bump");

      yield* store.markRead(undefined);

      expect((yield* store.inbox(Date.now() + 1)).entries).toEqual([]);

      yield* store.unpark("bump");

      expect((yield* store.inbox(0)).entries).toEqual([]);
    }),
  ));

test("tracking a repository again replaces its jobs, ignoring case", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      yield* store.track("timmo001/a", ["bump", "labels"]);

      const again = yield* store.track("Timmo001/A", ["drift"]);

      expect(again.repo).toBe("Timmo001/A");
      expect(again.jobs).toEqual(["drift"]);
      expect((yield* store.repos()).map((repo) => repo.repo)).toEqual([
        "Timmo001/A",
      ]);
      expect(yield* store.untrack("timmo001/a")).toBe(true);
      expect(yield* store.untrack("timmo001/a")).toBe(false);
      expect(yield* store.repos()).toEqual([]);
    }),
  ));

test("a worker's name never replaces one set by hand", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;
      const nameOf = Effect.map(store.repos(), ([repo]) => repo?.name);

      yield* store.track("timmo001/a", ["bump"]);
      yield* store.setNames([{ repo: "timmo001/a", name: "From dot" }]);
      expect(yield* nameOf).toBe("From dot");

      yield* store.rename("Timmo001/A", "By hand");
      yield* store.setNames([{ repo: "timmo001/a", name: "From dot again" }]);
      expect(yield* nameOf).toBe("By hand");

      yield* store.rename("timmo001/a", null);
      yield* store.setNames([{ repo: "timmo001/a", name: "From dot again" }]);
      expect(yield* nameOf).toBe("From dot again");
      expect(Option.isNone(yield* store.rename("timmo001/b", "Nope"))).toBe(
        true,
      );
    }),
  ));
