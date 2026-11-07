---
title: GitHub events
description: Let GitHub tell Upkeep about releases, pushes and workflow runs through a GitHub App, a Cloudflare Worker and a Cloudflare Queue.
---

Upkeep finds new work by polling on its schedules. GitHub can tell it
instead: a GitHub App sends every `release`, `push` and `workflow_run` from
your repositories to a Cloudflare Worker, which checks each delivery and adds
what Upkeep reads to a Cloudflare Queue. The server pulls from the queue
every few seconds, so nothing on it is opened to the internet, and events
wait out a restart: GitHub doesn't send a failed delivery again by itself,
but the queue keeps it for 24 hours.

Without the queue set up, the server runs on its schedules as it always has.
The schedules stay either way, as a slower catch-up for anything an event
misses.

## How it fits together

1. The **GitHub App** is installed on all your repositories, with read access
   to Contents and Actions, and a webhook for `release`, `push` and
   `workflow_run`. It needs no private key until it makes API calls itself.
2. The **events Worker** (`packages/events`) answers the webhook. It checks
   `X-Hub-Signature-256` against the webhook secret, rejecting everything
   when no secret is set, and queues only what Upkeep reads: the delivery ID,
   event, action, repository, ref, tag, the paths a push changed (up to 300)
   and the workflow run's name, branch and conclusion. A queue message is
   capped at 128 KB, and a push payload can be far bigger.
3. The **queue** has HTTP pull turned on.
4. The **server** pulls a batch, records each delivery by its ID so a repeat
   is dropped, then acknowledges the batch. A batch it can't record isn't
   acknowledged, so it comes back after a minute.

The server's log shows each new event, and events are kept for as long as
runs are (`keep_days`).

## Setting it up

1. Create the queue and turn on HTTP pull:

   ```bash
   cd packages/events
   bunx wrangler queues create upkeep-events
   bunx wrangler queues consumer http add upkeep-events
   ```

2. Deploy the Worker. Workers Builds deploys it from `main`, like the docs
   site, with `packages/events` as its root and `bunx wrangler deploy` as its
   deploy command. It answers at `events.upkeep.timmo.dev`.
3. Create the GitHub App under your account: its webhook URL is the Worker's,
   with a long random webhook secret, such as from `openssl rand -hex 32`.
   Give it read access to Contents and Actions, subscribe it to Release, Push
   and Workflow run, and install it on all your repositories.
4. Give the Worker the same secret:

   ```bash
   bunx wrangler secret put WEBHOOK_SECRET
   ```

5. Create a Cloudflare API token with Queues edit, then set the Home
   Assistant app's `events_account_id`, `events_queue_id` (from
   `bunx wrangler queues info upkeep-events`) and `events_token`. Outside the
   app, they're `UPKEEP_EVENTS_ACCOUNT_ID`, `UPKEEP_EVENTS_QUEUE_ID` and
   `UPKEEP_EVENTS_TOKEN`.

The App's **Advanced** page lists each delivery and its response: `202` when
it was queued or isn't an event Upkeep takes, `204` for the ping, and `401`
when the secret doesn't match.
