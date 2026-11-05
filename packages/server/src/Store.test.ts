/** The run lifecycle rules the server relies on, against an in-memory store. */
import { BunServices } from "@effect/platform-bun";
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
