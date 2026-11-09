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

The server's log shows each new event and the runs it queued, and events are
kept for as long as runs are (`keep_days`).

## What each event starts

| Event                                                            | What it does                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `release` published, or promoted from a pre-release (`released`) | Records the release and queues `bump` if it's new, as the `releases` job does. The scheduled `releases` run then finds it recorded and queues nothing. A paused or parked `bump` holds it until it's let go.       |
| `push` to the default branch                                     | Queues `watch` for the repository, and `sync` for it when it's tracked for sync. A push to groundwork queues `sync` for every app, and one to the skills repository queues `skill-consumers`.                      |
| `push` that changes the Renovate config or `tooling.yml`         | Also queues `deps` or `drift` for the repository. A push with more changed paths than the event carries (300) queues both.                                                                                         |
| `workflow_run` completed on the default branch                   | Queues `ci` for the repository. A successful publish run in `arch-repo` (named `Publish <package>`) also queues `up-first-party` on every worker, so each machine upgrades its first-party packages straight away. |

A run for one repository is only queued when the repository is tracked for
the job, or tracked at all for `watch`, and a waiting run for it or for every
repository is reused, so a burst of pushes queues one. Upkeep's own pushes
come back as events too: `watch` already knows their commits, and a `drift`
run that finds nothing to move ends as skipped.

Runs an event started show `event` as their trigger. `bump` starts seconds
after the release rather than up to 30 minutes later, so it finds the
consumers straight away and starts each one as soon as the packages it needs
reach npm, checking every 15 seconds for up to 20 minutes. Consumers of the
release's workflow pins don't wait at all.

## Setting it up

1. Create the queue and turn on HTTP pull:

   ```bash
   cd packages/events
   bunx wrangler queues create upkeep-events
   bunx wrangler queues consumer http add upkeep-events
   ```

2. Deploy the Worker with `bun run deploy` in `packages/events`. It answers
   at `events.upkeep.timmo.dev`. To deploy it from `main` instead, connect it
   to Workers Builds like the docs site, with `packages/events` as its root
   and `bunx wrangler deploy` as its deploy command.
3. Create the GitHub App under your account: its webhook URL is the Worker's,
   with a long random webhook secret, such as from `openssl rand -hex 32`.
   Give it read access to Contents and Actions, subscribe it to Release, Push
   and Workflow run, and install it on all your repositories.
4. Give the Worker the same secret. With it kept in 1Password, pipe it in so
   it never shows on screen:

   ```bash
   op item get "Upkeep GitHub App webhook secret" --fields password --reveal \
     | tr -d '\n' | bunx wrangler secret put WEBHOOK_SECRET
   ```

5. Create a Cloudflare API token limited to your account, with only Queues
   Write, then set the Home Assistant app's `events_account_id` (from
   `bunx wrangler whoami`), `events_queue_id` (from
   `bunx wrangler queues info upkeep-events`) and `events_token`, and restart
   it. Outside the app, they're `UPKEEP_EVENTS_ACCOUNT_ID`,
   `UPKEEP_EVENTS_QUEUE_ID` and `UPKEEP_EVENTS_TOKEN`. Keeping all three in
   one 1Password item makes them easy to set again. The app's log says
   "Pulling GitHub events from the Cloudflare Queue" once it's on.

The App's **Advanced** page lists each delivery and its response: `202` when
it was queued or isn't an event Upkeep takes, `204` for the ping, and `401`
when the secret doesn't match.

## Jobs as the App

The same App can run the jobs' own GitHub calls, so a day of bumps and syncs
counts against the App's rate limit rather than your account's, and their
pushes show as the App. The server holds the App's private key and hands each
worker an installation token, which it renews before the hour it lasts runs
out. The jobs that work across repositories on their own use it: bump,
labels, stalled updates, drift, sync, dependencies, watch and skill
consumers. Heals, changes, agents and the jobs that read what involves you,
such as attention, notifications and CI, which reads your CI notifications,
keep the worker's own `gh` login. So does bump's search for the repositories
that use a release, since GitHub's code search returns only some of its
matches to an installation token.

1. Give the App read and write access to Contents, Pull requests, Issues,
   Workflows and Actions, and read access to Dependabot alerts, and approve
   the new permissions on its installation. Workflows is needed because bumps
   and drift edit `.github/workflows`, and Dependabot alerts because the
   dependencies job plans fixes for them.
2. Generate a private key on the App's page, keep it in 1Password, and delete
   the downloaded file.
3. Set the Home Assistant app's `github_app_id` and `github_app_key`, the key
   pasted as it is or in base64, and restart it. Outside the app, they're
   `UPKEEP_GITHUB_APP_ID` and `UPKEEP_GITHUB_APP_KEY`. Set
   `github_app_account` only when the App is installed on more than one
   account. The app's log says "Handing workers GitHub App tokens for the
   jobs' GitHub calls" once it's on.
4. Add the App as a bypass actor on any ruleset that stops direct pushes to
   the default branch, as it pushes there in place of your account.

A run of one of those jobs points `gh` at the token through `GH_TOKEN`, and
`git` at GitHub over HTTPS with a credential helper that gives the token, so
clones with an SSH remote push as the App too. Without the App set up, or
when the server can't make a token, every job uses the worker's login.
