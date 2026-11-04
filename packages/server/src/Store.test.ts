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

test("a running run with no recent heartbeat fails as lost", () =>
  run(
    Effect.gen(function* () {
      const store = yield* Store;

      yield* store.queueRun({
        job: "releases",
        trigger: "manual",
        release: null,
      });
      yield* store.claim(["releases"], "desktop");

      const lost = yield* store.failLost(Date.now() + 1);

      expect(lost.map((run) => run.state)).toEqual(["failed"]);
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
