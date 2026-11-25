/**
 * GitHub events through the server's pull: a release event queues its bump
 * once, a repeated delivery is dropped, and the batch is acked. Also the
 * status, the heal a batch of runs shares once it has ended, which workers
 * the machine jobs queue on, and when one failing on a worker needs you.
 */
import { BunServices } from "@effect/platform-bun";
import { Catalogue, type Domain } from "@upkeep/api";
import { expect, test } from "bun:test";
import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { Events } from "./Events";
import {
  cronCache,
  followMachine,
  healEnded,
  pullEvents,
  queueMachineRuns,
  status,
} from "./Server";
import { Store } from "./Store";
import { Triage } from "./Triage";

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

const setup: Domain.AgentSetup = {
  decisions: null,
  agents: [],
  launch: false,
  resume: false,
};

test("the status says when every live worker only maintains itself", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;

      yield* store.setAgents("nas", setup, {
        stages: ["dotfiles"],
        only: true,
      });

      const maintaining = yield* status();

      expect(maintaining.health).toBe("degraded");
      expect(maintaining.summary).toBe(
        "Nothing needs you, but no worker runs jobs: nas only maintains itself",
      );

      yield* store.setAgents("desktop", setup, {
        stages: ["dotfiles"],
        only: false,
      });

      expect((yield* status()).health).toBe("ok");
    }).pipe(
      Effect.provide(Store.layerFile(":memory:")),
      Effect.provide(BunServices.layer),
    ),
  ));

test("machine jobs queue only on the workers that run their stage, on each one's cron", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;

      // An older worker that doesn't say runs every stage
      yield* store.setAgents("desktop", setup);

      yield* store.setAgents("nas", setup, {
        stages: ["dotfiles", "tools"],
        schedules: { tools: "30 4 * * 0" },
        only: true,
      });

      const asked: Array<string> = [];
      const cached = cronCache();

      yield* queueMachineRuns((expression) => {
        asked.push(expression);

        return cached(expression);
      });

      const queued = (yield* store.runs({ limit: 50 })).map(
        (run) =>
          `${run.job}:${run.command?.kind === "machine" ? run.command.worker : ""}`,
      );

      expect(queued.filter((run) => run.endsWith(":nas")).toSorted()).toEqual([
        "dotfiles:nas",
        "tools:nas",
      ]);

      // Every stage but the opt-in ones
      expect(queued.filter((run) => run.endsWith(":desktop"))).toHaveLength(
        Catalogue.machineJobs.filter((job) => job.optIn !== true).length,
      );

      expect(asked).toContain("30 4 * * 0");

      // Dropping a stage drops its queued run on that worker only
      yield* store.setAgents("nas", setup, {
        stages: ["dotfiles"],
        only: true,
      });

      const left = yield* store.runs({ job: "tools", limit: 10 });

      expect(
        left.map((run) =>
          run.command?.kind === "machine" ? run.command.worker : "",
        ),
      ).toEqual(["desktop"]);
    }).pipe(
      Effect.provide(Store.layerFile(":memory:")),
      Effect.provide(BunServices.layer),
    ),
  ));

test("a machine job still failing on a worker hours later needs you, until a run there passes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;

      yield* store.setAgents("station", setup);

      const end = Effect.fnUntraced(function* (
        hour: number,
        outcome: Domain.Outcome,
      ) {
        yield* TestClock.setTime(hour * 3_600_000);

        const queued = yield* store.queueRun({
          job: "first-party",
          trigger: "schedule",
          release: null,
          command: { kind: "machine", worker: "station" },
        });

        yield* store.claim(["first-party"], "station");

        const run = yield* store.finish(
          queued.id,
          "station",
          outcome,
          outcome === "failed" ? "unable to lock database" : null,
        );

        yield* followMachine(run);

        return (yield* status()).needs.map((item) => item.title);
      });

      const stuck = "dot up first-party keeps failing on station";

      // Once is a blip, and twice within the hours could be one too
      expect(yield* end(0, "failed")).toEqual([]);
      expect(yield* end(1, "failed")).toEqual([]);
      expect(yield* end(3, "failed")).toEqual([stuck]);
      expect(yield* end(4, "failed")).toEqual([stuck]);
      expect(yield* end(5, "succeeded")).toEqual([]);

      // A new streak counts from its own first failure
      expect(yield* end(6, "failed")).toEqual([]);
    }).pipe(
      Effect.provide(Store.layerFile(":memory:")),
      Effect.provide(TestClock.layer()),
      Effect.provide(BunServices.layer),
    ),
  ));

test("an opt-in stage only runs on the workers that list it", () => {
  const job: Domain.Job = {
    id: "dotfiles",
    name: "dot up dotfiles",
    description: "Pulls the dotfiles",
    schedule: null,
    onRelease: false,
    lane: "machine",
    tracked: false,
    machine: true,
    stage: "dotfiles",
    optIn: true,
  };

  expect(Catalogue.runsOn(job, undefined)).toBe(false);
  expect(Catalogue.runsOn(job, { stages: [], only: false })).toBe(false);
  expect(Catalogue.runsOn(job, { stages: ["dotfiles"], only: false })).toBe(
    true,
  );
});

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

test("a batch's failures wait for the batch, then share one heal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;
      const repos = ["timmo001/a", "timmo001/b", "timmo001/c"];

      const batch = yield* store.queueBatch(
        { job: "deps", trigger: "schedule", release: null },
        repos,
      );

      // a and c fail, b passes, in that order
      const outcomes = ["failed", "succeeded", "failed"] as const;
      const ended: Array<Domain.Run> = [];

      for (const [index, outcome] of outcomes.entries()) {
        const claimed = yield* store.claim(["deps"], "desktop");

        expect(Option.getOrNull(claimed)?.id).toBe(batch[index]?.id);

        const run = yield* store.finish(
          batch[index]?.id ?? "",
          "desktop",
          outcome,
          outcome === "failed" ? `${repos[index]} broke` : null,
        );

        ended.push(run);

        yield* healEnded(run, outcome === "failed" ? [repos[index] ?? ""] : []);

        const heals = yield* store.runs({ job: "heal", limit: 10 });

        // Nothing is healed until the last run of the batch has ended
        expect(heals).toHaveLength(index < 2 ? 0 : 1);
      }

      const [healRun] = yield* store.runs({ job: "heal", limit: 10 });

      expect(healRun?.heal?.target).toEqual({
        kind: "consumers",
        repos: ["timmo001/a", "timmo001/c"],
      });

      for (const id of [batch[0]?.id ?? "", batch[2]?.id ?? ""])
        expect((yield* store.run(id)).heals).toEqual([healRun?.id ?? ""]);

      expect((yield* store.run(batch[1]?.id ?? "")).heals).toEqual([]);
    }).pipe(
      Effect.provide(Store.layerFile(":memory:")),
      Effect.provide(Triage.none),
      Effect.provide(BunServices.layer),
    ),
  ));

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
