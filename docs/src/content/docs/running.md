---
title: Running it
description: Run the Upkeep server, add workers and admins, and start, list and follow runs from the CLI.
---

Everything is one `upkeep` binary. The server keeps the runs and their logs
and queues jobs on their schedule; workers take runs from it and do the work.

## Server

```bash
upkeep serve
```

It listens on `127.0.0.1:7272` by default. Set `UPKEEP_HOSTNAME` and
`UPKEEP_PORT`, or pass `--hostname` and `--port`, to change that, and put it
behind a reverse proxy for HTTPS.

| Setting                     | Use                                                                    |
| --------------------------- | ---------------------------------------------------------------------- |
| `UPKEEP_SERVER_DB`          | Where the SQLite database lives                                        |
| `UPKEEP_SERVER_ADMIN_TOKEN` | An admin token of at least 32 characters, for the first admin commands |
| `UPKEEP_HEALS_PER_DAY`      | How many heals one job can have a day before it's parked, 3 by default |

## Tokens

Admins read runs, start jobs and manage tokens; workers take runs. Each token
is shown once and stored only as a hash.

```bash
export UPKEEP_SERVER=https://upkeep.example.com
export UPKEEP_ADMIN_TOKEN=...

upkeep admins add aidan
upkeep workers add desktop
upkeep workers list
upkeep workers remove desktop
```

## Workers

```bash
UPKEEP_WORKER_TOKEN=... upkeep worker
```

A worker asks for work every 30 seconds, sends a heartbeat every minute while
a run goes and sends its log as it's written. The server fails a run as lost
when its worker has been quiet for 10 minutes, and a worker that's stopped
fails its run straight away. A worker reads GitHub through `gh`, logged in as
whoever runs it.

## Runs

```bash
upkeep run releases
upkeep run releases --local
upkeep runs --job releases --state failed
upkeep log <run> --follow
upkeep cancel <run>
upkeep runs --job heal
upkeep unpark <job>
```

`upkeep run` queues a run for a worker; a run of the same job and release
that's still waiting is reused instead. With `--local` it runs here instead,
printing its log and reporting nothing to the server.

`upkeep cancel` drops a queued run from the queue. A running one is marked
`cancelled`, and its worker stops it at its next heartbeat.

## Heals

When a run fails or is lost, the server queues a `heal` run for it. A failed
`bump` gets one heal per consumer that failed, each with that consumer as its
target; any other failure gets one heal with Upkeep itself as the target. A
failed heal never queues another.

Each heal keeps a record of the failed run, what was decided and why, the
model and variant used, what was done, the commit if there was one and the
OpenCode session. `upkeep runs --job heal` lists heals with what they heal.

A job that would go past `UPKEEP_HEALS_PER_DAY` heals in a day is parked
instead. The server stops queueing a parked job on its schedule or on
releases, though it can still be run by hand, and `upkeep status --json`
shows why it's parked. `upkeep unpark <job>` lets it be queued again.

A heal reads the failed run's error and the end of its log, and a decision
model chooses what to do:

- `retry` queues the failed job again, for the same release.
- `fix` picks an agent from the worker's list to fix it. Agent fixes aren't
  wired up yet, so for now it's left for a person.
- `park` parks the job, with the model's reason.
- `ask` leaves it for a person.

The decision model and agents go in the worker's config file. The model is
any TypeSafe System One API at `url`, with `UPKEEP_DECISION_API_KEY` when it
needs one, or Clef on Cloudflare Workers AI with `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` and `"provider": "cloudflare"`. The first agent is the
default; with more than one, the model picks by what each is `for`:

```json
{
  "heal": {
    "decisions": {
      "provider": "typesafe",
      "url": "http://localhost:11434",
      "model": "jev-latest"
    },
    "agents": [
      { "model": "provider/model", "variant": "high", "for": "Most fixes" }
    ]
  }
}
```

Without a decision model, a lost run is retried and anything else is left
for a person.

## Jobs

| Job        | Runs             | Does                                                                                                                                                                                                                                                                       |
| ---------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `releases` | Every 30 minutes | Reads the latest release of each repository I own, skipping forks and archived ones, and queues the jobs that run on a new one. A first sighting is only recorded.                                                                                                         |
| `labels`   | Daily at 04:00   | Brings each repository's labels in line with groundwork's conventions. Old names are renamed in place through aliases, so issues keep their labels. A label the conventions don't know is deleted when nothing uses it, and otherwise left and listed in the log.          |
| `bump`     | On a new release | Rolls the release out to the repositories that use it, found through code search: workflow and action pins of the released repository, and `package.json` dependencies on the packages it publishes. Each one is checked, pushed to its default branch and its CI watched. |
| `heal`     | On a failed run  | Fixes a failed or lost run: retries it, hands it to an agent, parks the job or asks. See [Heals](#heals).                                                                                                                                                                  |

The `labels` job reads the conventions from a groundwork checkout, set by
`UPKEEP_GROUNDWORK` on the worker.

### Bump

For each consumer, the `bump` job clones the default branch, moves the pins
to the release's commit and the dependencies to its version, and installs
where a changed `package.json` has a lockfile. A dependency change is then
checked with `mise run check` and `mise run build` where the repository has
those tasks. A pin only changes workflows, so it goes straight to the push
and CI checks it. After the push the job waits for the commit's CI runs, and
a failed run fails that consumer. One consumer failing doesn't stop the
others; the run fails at the end, naming them.

A package is only bumped once its version is on npm, waiting up to 20
minutes for the publish. Clones are kept in `upkeep/bump` in the XDG cache
directory and reused.

Set `UPKEEP_BUMP_DRY_RUN=true` to stop before each commit and log what would
be pushed.

A repository that doesn't follow groundwork's tasks can have its own checks
in the worker's config file, `$UPKEEP_CONFIG` or `upkeep/config.json` in the
XDG config directory:

```json
{
  "bump": {
    "repos": {
      "owner/name": { "checks": ["npm test", "npm run build"] }
    }
  }
}
```
