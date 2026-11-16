/**
 * The events Worker's infrastructure as an Alchemy stack: the `upkeep-events`
 * Worker at events.upkeep.timmo.dev, producing to the `upkeep-events` Queue
 * the server pulls from. Deploy it with `mise run events:deploy`, with the
 * GitHub App's webhook secret in WEBHOOK_SECRET.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "upkeep-events",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // Both were made by hand with Wrangler before this stack, so they're
    // adopted rather than failing as someone else's. The queue's HTTP pull
    // consumer stays as it was set up, outside the stack
    const queue = yield* Cloudflare.Queues.Queue("Queue", {
      name: "upkeep-events",
    }).pipe(Alchemy.AdoptPolicy.adopt(true));

    const events = yield* Cloudflare.Worker("Worker", {
      name: "upkeep-events",
      main: "src/index.ts",
      domain: "events.upkeep.timmo.dev",
      workersDev: false,
      compatibility: { date: "2026-10-01" },
      env: {
        EVENTS: queue,
        WEBHOOK_SECRET: Config.Redacted("WEBHOOK_SECRET"),
      },
    }).pipe(Alchemy.AdoptPolicy.adopt(true));

    return { url: events.url };
  }),
);
