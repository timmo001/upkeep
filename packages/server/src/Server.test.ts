/**
 * GitHub events through the server's pull: a release event queues its bump
 * once, a repeated delivery is dropped, and the batch is acked.
 */
import { BunServices } from "@effect/platform-bun";
import type { Domain } from "@upkeep/api";
import { expect, test } from "bun:test";
import { Effect, Layer, Option } from "effect";
import { Events } from "./Events";
import { pullEvents, status } from "./Server";
import { Store } from "./Store";

const release = (tag: string): Domain.GitHubEvent => ({
  delivery: `delivery-${tag}`,
  event: "release",
  action: "released",
  repo: "timmo001/a",
  defaultBranch: "main",
  sender: "timmo001",
  ref: null,
  paths: [],
  truncated: false,
  release: { tag, url: `https://github.com/timmo001/a/releases/tag/${tag}` },
  workflow: null,
  at: 1,
});

test("the status counts what needs you, and says when no worker is live", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;

      const quiet = yield* status();

      expect(quiet.health).toBe("degraded");
      expect(quiet.needs).toEqual([]);

      yield* store.setAgents("desktop", {
        decisions: null,
        agents: [],
        launch: false,
        resume: false,
      });

      expect((yield* status()).health).toBe("ok");
      expect((yield* status()).summary).toBe("Nothing needs you");

      yield* store.park("drift", "It failed 3 times today", null);

      const parked = yield* status();

      expect(parked.health).toBe("warning");
      expect(parked.parked).toEqual(["drift"]);
      expect(parked.needs.map((item) => item.kind)).toEqual(["needs"]);
      expect(parked.needs[0]?.path).toBe("jobs/drift");
      expect(parked.workers).toEqual(["desktop"]);
    }).pipe(
      Effect.provide(Store.layerFile(":memory:")),
      Effect.provide(BunServices.layer),
    ),
  ));

test("a burst of pushes queues one run of each job the repository is tracked for", () => {
  const push = (delivery: string): Domain.GitHubEvent => ({
    delivery,
    event: "push",
    action: null,
    repo: "timmo001/a",
    defaultBranch: "main",
    sender: "timmo001",
    ref: "refs/heads/main",
    paths: ["renovate.json"],
    truncated: false,
    release: null,
    workflow: null,
    at: 1,
  });

  const events = Layer.succeed(
    Events,
    Events.of({
      enabled: true,
      pull: () =>
        Effect.succeed(
          ["p1", "p2"].map((delivery) => ({
            lease: delivery,
            event: Option.some(push(delivery)),
          })),
        ),
      ack: () => Effect.void,
    }),
  );

  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;

      // Tracked for deps but not sync, so only deps and watch run for it
      yield* store.track("timmo001/a", ["deps"]);

      yield* Layer.build(pullEvents.pipe(Layer.provide(events)));
      yield* Effect.sleep("200 millis");

      const queued = yield* store.runs({ limit: 10 });

      expect(
        queued.map((run) => `${run.job}:${run.repo}:${run.trigger}`).toSorted(),
      ).toEqual(["deps:timmo001/a:event", "watch:timmo001/a:event"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Store.layerFile(":memory:")),
      Effect.provide(BunServices.layer),
    ),
  );
});

test("a release event queues its bump once and the batch is acked", () => {
  const acked: Array<string> = [];

  const events = Layer.succeed(
    Events,
    Events.of({
      enabled: true,
      // The same delivery twice, as the queue sends a message again
      pull: () =>
        Effect.succeed(
          ["first", "again"].map((lease) => ({
            lease,
            event: Option.some(release("v2")),
          })),
        ),
      ack: (leases) => Effect.sync(() => acked.push(...leases)),
    }),
  );

  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;

      yield* store.track("timmo001/a", ["releases", "bump"]);
      // A repository's first release is only recorded, so v2 is new
      yield* store.recordReleases([{ repo: "timmo001/a", tag: "v1", url: "" }]);

      yield* Layer.build(pullEvents.pipe(Layer.provide(events)));
      yield* Effect.sleep("200 millis");

      const bumps = yield* store.runs({ job: "bump", limit: 10 });

      expect(bumps).toHaveLength(1);
      expect(bumps[0]?.trigger).toBe("event");
      expect(bumps[0]?.release?.tag).toBe("v2");
      expect(acked.slice(0, 2)).toEqual(["first", "again"]);
      expect((yield* store.events(0)).map((event) => event.delivery)).toEqual([
        "delivery-v2",
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Store.layerFile(":memory:")),
      Effect.provide(BunServices.layer),
    ),
  );
});
