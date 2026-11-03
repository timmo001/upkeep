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
