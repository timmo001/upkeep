/**
 * GitHub events through the server's pull: a release event queues its bump
 * once, a repeated delivery is dropped, and the batch is acked.
 */
import { BunServices } from "@effect/platform-bun";
import type { Domain } from "@upkeep/api";
import { expect, test } from "bun:test";
import { Effect, Layer, Option } from "effect";
import { Events } from "./Events";
import { pullEvents } from "./Server";
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
