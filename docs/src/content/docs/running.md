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
| `UPKEEP_HEALS_PER_DAY`      | How many heals a job can have a day for each target, 3 by default      |
| `UPKEEP_KEEP_DAYS`          | How many days finished runs and their logs are kept, 30 by default     |
| `UPKEEP_KEEP_RUNS`          | How many of each job's latest finished runs are kept however old, 20   |
| `UPKEEP_TRIAGE_URL`         | Triage's address, for the failure memory below; optional               |
| `UPKEEP_TRIAGE_HOST_TOKEN`  | A triage host token, to send failures as events                        |
| `UPKEEP_TRIAGE_ADMIN_TOKEN` | A triage admin token, to read and resolve their issues                 |

The settings can also come from a JSON file at `UPKEEP_OPTIONS`, with
lowercase keys and no `UPKEEP_` prefix, such as `{ "keep_days": 14 }`. The
environment wins over the file.

### Home Assistant

The server also ships as a Home Assistant app, `ghcr.io/timmo001/upkeep-app`,
for aarch64 and amd64. It keeps its database in the app's data and serves the
API on port 7272. Its options are the settings above, lowercase and without
the `UPKEEP_` prefix. Set **server_admin_token** to add the first admin and
workers with `--server`. The dashboard shows in Home Assistant's sidebar
through ingress, with no token needed.

The app is in [timmo001/home-assistant-apps](https://github.com/timmo001/home-assistant-apps),
which each release copies it into. Add that repository, then open the app to
install it:

[![Add the apps repository to your Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Ftimmo001%2Fhome-assistant-apps)

[![Open the Upkeep app in your Home Assistant](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=0530478f_upkeep&repository_url=https%3A%2F%2Fgithub.com%2Ftimmo001%2Fhome-assistant-apps)

`--ingress-port` (`UPKEEP_INGRESS_PORT`) serves the API and dashboard on a
second port for ingress, 8099 in the app. It only answers `--ingress-from`
(`UPKEEP_INGRESS_FROM`), the Supervisor at `172.30.32.2` by default, and
treats every request as an admin's, since Home Assistant has already signed
the user in.

## Dashboard

The server serves the dashboard at its root, such as
`http://127.0.0.1:7272/`. It opens with the last day in a line: how runs
ended, how many commits they pushed and to how many repositories, the runs
that left something for you, and the recent commits, each linked to GitHub
and the run that pushed it. Below that are the jobs with their last run and
whether they're parked, then the latest runs with what each did. Each run
shows its summary, its commits, its heal record and its log, which follows
the run as it goes. Jobs can be run or unparked, and runs cancelled, from
there. It asks for an admin token the first time and keeps it in the browser.

The same day is `GET /api/activity?hours=24`, and the `activity` tool in MCP
and Code Mode.

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

The CLI also reads both from `~/.config/upkeep/admin.env` (under
`$XDG_CONFIG_HOME`) when they aren't in the environment, so its MCP server and
the OpenCode plugin find the server however they were started:

```bash
UPKEEP_SERVER=https://upkeep.example.com
UPKEEP_ADMIN_TOKEN=...
```

### First setup with 1Password

[`.scripts/setup-1password.sh`](https://github.com/timmo001/upkeep/blob/main/.scripts/setup-1password.sh)
sets up a new server with every token kept in 1Password, so none of them pass
through the terminal or shell history. It needs `op`, `jq`, `curl` and
`upkeep`:

```bash
curl -fsSLO https://raw.githubusercontent.com/timmo001/upkeep/main/.scripts/setup-1password.sh
bash setup-1password.sh https://upkeep.example.com aidan desktop laptop
```

It makes the server admin token and copies it, then waits while you set it as
`UPKEEP_SERVER_ADMIN_TOKEN`, or the app's **server_admin_token**, and restart
the server. Then it adds the admin and each worker named after it, saving
their tokens as `Upkeep admin token - aidan`, `Upkeep worker token - desktop`
and so on. Run it again to pick up where it stopped: items already saved are
kept. Read one back with `op item get "<title>" --fields credential --reveal`.
Once your own admin is saved, the server admin token can go.

## Workers

```bash
UPKEEP_WORKER_TOKEN=... upkeep worker
```

A worker asks for work every 30 seconds, sends a heartbeat every minute while
a run goes and sends its log as it's written. When a worker is stopped mid-run,
such as by a restart after an upgrade, or goes quiet for 10 minutes, the server
puts its run back at the front of the queue. That happens once per run: the
second time, the run fails as lost, so a run that brings its worker down can't
loop. A worker reads GitHub through `gh`, logged in as whoever runs it.

A worker runs jobs in three lanes at once, one run per lane, so a long job
doesn't hold up the others: heals in one, the quick API-only jobs
(`releases`, `labels`, `notifications` and `digest`) in another, and the jobs
that clone and push to repositories in the third, where they take turns.

On Arch, the `upkeep-git` package builds the binary from main and installs a
`upkeep-worker` user service. Put `UPKEEP_SERVER` and `UPKEEP_WORKER_TOKEN` in
`~/.config/upkeep/worker.env`, along with a `PATH` that finds the tools the
jobs use, such as `mise`, `opencode2` and `plannotator`, then run
`systemctl --user enable --now upkeep-worker.service`.

A worker keeps its status in `$XDG_STATE_HOME/upkeep/worker-status.json`, or
`$UPKEEP_WORKER_STATUS`: a `health`, a one-line `summary` and when it was
`updated`. The summary says what's running, how the last run ended, which
jobs are parked and how many heals in the last day asked for a person, so a
service monitor can show more than that the process is up. It's `warning`
while anything needs a person and `degraded` while the server can't be
reached.

## Repositories

Jobs that work on repositories (`releases`, `labels`, `bump`,
`notifications`, `stalled-updates`, `drift`, `deps` and `ci`) only touch the ones
the server tracks for them. Every other repository is left alone, and with
none tracked they do nothing.

```bash
upkeep repos add owner/name
upkeep repos add owner/name --job bump --job labels
upkeep repos list
upkeep repos remove owner/name
```

`upkeep repos add` without `--job` opts a repository into every job that
works on repositories; with it, only the jobs given. Adding a repository again
replaces its jobs. A job added to Upkeep later stays off for repositories
already tracked until they're opted into it. Only the releases of
repositories tracked for `releases` count, and `bump` only rolls a release out
to consumers tracked for `bump`.

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
printing its log and reporting nothing to the server. It still reads the
repositories tracked for the job from the server, so it needs `--server` and
an admin token.

`upkeep cancel` drops a queued run from the queue. A running one is marked
`cancelled`, and its worker stops it at its next heartbeat.

Once an hour the server deletes finished runs older than `UPKEEP_KEEP_DAYS`
and their logs, keeping the latest `UPKEEP_KEEP_RUNS` of each job. Queued and
running runs are never pruned.

## Heals

When a run fails or is lost, the server queues a `heal` run for it. A failed
run of a job over repositories, such as `bump`, `stalled-updates`, `drift` or
`ci`, gets one heal per repository that failed, each with that repository as
its target; any other failure gets one heal with Upkeep itself as the target.
A failed heal never queues another.

Each heal keeps a record of the failed run, what was decided and why, the
model and variant used, what was done, the commit if there was one and the
OpenCode session. `upkeep runs --job heal` lists heals with what they heal.

A job gets `UPKEEP_HEALS_PER_DAY` heals a day for each target. A repository
past that gets no more heals that day, while the job carries on for the
others. A job failing in itself past that is parked instead. The server stops
queueing a parked job on its schedule or on releases, though it can still be
run by hand, and `upkeep status --json` shows why it's parked.
`upkeep unpark <job>` lets it be queued again.

A heal reads the failed run's error and the end of its log, and a decision
model chooses what to do:

- `retry` queues the failed job again, for the same release.
- `fix` picks an agent from the worker's list to fix it. The worker checks
  out the target in `upkeep/heal` in the XDG cache directory, creates an
  OpenCode session with the agent's model and variant, checking OpenCode has
  both, and runs it headless with `opencode run --auto`, named for the job
  and repository, with the failure as its prompt. Nothing opens on the
  desktop. The agent gets `sessionMinutes` (30 by default) to finish; every
  commit it pushes to the default branch is recorded as the heal's changes,
  and what it said last as its summary. One that stopped, ran out of time or
  asked for you is marked as needing you, and its Inbox message names the
  session to pick it up from.
- `park` parks the job, with the model's reason.
- `ask` means the model isn't sure, so the last agent, the one for hard fixes,
  works on it as for `fix`.

The decision model and agents go in the worker's config file. The model is
any TypeSafe System One API at `url`, such as Ollaya or Ollama on the worker,
with `UPKEEP_DECISION_API_KEY` when it needs one, Clef on Cloudflare Workers
AI with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` and
`"provider": "cloudflare"`, or an LLM through OpenCode with
`"provider": "opencode"` and a `provider/model` model, for a worker without a
local model. `decisionsPerDay` caps how many heals a day the model chooses:
unlimited by default, 300 for `opencode`. Set one for a cloud model on a
shared or metered plan; past it, heals wait for the digest. The first agent is the default; with more than one, the model
picks by what each is `for`:

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
    ],
    "sessionMinutes": 30
  }
}
```

`opencode` sets the OpenCode command (`opencode2` by default) and `repo`
Upkeep's own repository, for a heal that targets Upkeep. The worker needs
Herdr running for a fix; without it, the fix waits for the digest.

Without a decision model, a lost run is retried and anything else waits for
the evening digest.

### Triage

With the three `UPKEEP_TRIAGE_*` settings on the server, each failure that's
healed is sent to triage as an error, so the same failure groups into one
issue there. A heal reads the notes on that issue and on similar ones, and
both the decision model and the agent see how those went. When a fix is
pushed, the server resolves the issue with a note on what fixed it. A job
parked for a failure unparks once its triage issue is resolved, checked every
minute. Without triage, heals work the same with no memory.

In the Home Assistant app, only the two tokens are needed when the triage
app from the same repository is installed and running: the server asks the
Supervisor for its address on startup and logs the one it uses.

### Inbox

A heal only messages the Plannotator Inbox, in the `Upkeep heals` thread,
when there's something for a person to do: a job it parked, or a fix an
agent left unfinished, with the session to pick it up from. The message is an
action item that says what to do and what was tried, and quotes the log lines
about that target, such as the one consumer's failed check out of a run over
many. Everything else goes in the digest: the `digest` job sends the day's
heals there as one
message each evening. `inbox` in the worker's `heal` settings sets the
Plannotator command (`plannotator` by default, or `false` to send nothing),
and `inboxProject` the folder whose Inbox project they go to, the home folder
by default.

## Jobs

| Job               | Runs             | Does                                                                                                                                                                                                                                                                       |
| ----------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `releases`        | Every 30 minutes | Reads the latest release of each repository I own tracked for it, skipping forks and archived ones, and queues the jobs that run on a new one. A first sighting is only recorded.                                                                                          |
| `labels`          | Daily at 04:00   | Brings each repository's labels in line with groundwork's conventions. Old names are renamed in place through aliases, so issues keep their labels. A label the conventions don't know is deleted when nothing uses it, and otherwise left and listed in the log.          |
| `bump`            | On a new release | Rolls the release out to the repositories that use it, found through code search: workflow and action pins of the released repository, and `package.json` dependencies on the packages it publishes. Each one is checked, pushed to its default branch and its CI watched. |
| `heal`            | On a failed run  | Fixes a failed or lost run: retries it, hands it to an agent, parks the job or asks. See [Heals](#heals).                                                                                                                                                                  |
| `digest`          | Daily at 20:00   | Sends the day's heals to the Inbox as one message. See [Inbox](#inbox).                                                                                                                                                                                                    |
| `notifications`   | Every 15 minutes | Dismisses unread GitHub notifications for Renovate and Dependabot pull requests that have merged, and logs each one. A thread that changed since it was read is left, and anything else stays unread.                                                                      |
| `stalled-updates` | Hourly           | Takes over Renovate and Dependabot pull requests whose checks failed: squashes each onto the default branch, checks it, pushes it and closes the pull request. See [Stalled updates](#stalled-updates).                                                                    |
| `drift`           | Every 6 hours    | Checks each repository's `tooling.yml` against the latest releases of its tools, pushes the pin moves that need no review, and fails with what to review for the rest. See [Drift](#drift).                                                                                |
| `deps`            | Every 6 hours    | Reads each repository's Renovate config, presets and all, without running Renovate, and logs the groups of updates it would open with who owns each: Renovate when it automerges the group, otherwise Upkeep. It changes nothing yet.                                      |
| `ci`              | Hourly           | Reads the latest CI on each repository's default branch, runs the checks of a red one here and fails with both, so a heal fixes it forward. See [CI](#ci).                                                                                                                 |

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
others; the run fails at the end, naming them. A release nothing uses ends
`skipped`, and the dashboard leaves skipped runs out of the list of every
job's runs.

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

### Stalled updates

Each hour the `stalled-updates` job finds the open Renovate and Dependabot
pull requests in the signed-in account's repositories and takes over those
whose checks all finished and some failed. It reads no updater config, only
each pull request's diff, so it works with any config. Drafts, forks,
archived repositories, pull requests into other branches, abandoned updates
and onboarding are left alone, as are pull requests whose checks pass or are
still running, which the updater merges itself, and those that conflict with
the default branch, which it rebases.

Each update is squashed onto a clean clone of the default branch, its
dependencies installed, and checked as a bump is (with the same
per-repository checks). A repository with no check or build task to run is
left alone, since its checks already failed there and nothing here could
show the update works. Otherwise it's pushed as the pull request's title, and the
pull request is closed with a comment linking the commit. The job then waits
for the commit's CI. A repository that fails at any step is logged and the
others carry on; the run fails at the end, naming them, and a heal for each
one hands the update to an agent to apply and fix forward.

Clones are kept in `upkeep/stalled-updates` in the XDG cache directory. Set
`UPKEEP_STALLED_UPDATES_DRY_RUN=true` to stop before each commit and log what
would be pushed. A dry run logs the repositories that failed rather than
failing, so it queues no heals.

### CI

Each hour the `ci` job reads the latest finished run of each workflow on
every tracked repository's default branch, skipping archived ones. Pull
request runs and cancelled runs are left out. When a workflow's latest run
failed, the job logs the end of its failed steps, then runs the repository's
checks in a clean clone, as a bump does, and logs how they went: whether
installing changed a lockfile, which a frozen install in CI refuses, whether
the checks fail here too, or whether they pass, so it fails only in CI. The
run fails at the end, naming the red repositories, and a heal for each one
hands both results to an agent to fix the cause, push and watch CI.

Once a workflow's latest run passes again, the job dismisses the unread
"workflow run failed" notifications for it on the default branch.

Clones are kept in `upkeep/ci` in the XDG cache directory.

### Drift

Every six hours the `drift` job finds the signed-in account's repositories
with a `tooling.yml` at their root, which records the tools each one wraps,
configures or forks, and the release of each last reviewed:

```yaml
tools:
  - repo: cli/cli # whose releases are tracked
    reviewed: v2.89.0 # the release last reviewed
    update: mise run tooling:refresh # optional; run with the new tag
    pins: # optional; files a pin move touches, tooling.yml by default
      - tooling.yml
    review: Check the snapshot under tooling/gh against src/. # optional
  - repo: omacom/omarchy
    reviewed: v4.5.0-rc2
    prereleases: true # optional; follow prereleases too
  - repo: Effect-TS/effect
    reviewed: effect@4.0.1
    tags: ^effect@ # optional; follow the newest matching tag
```

A tool is followed to its latest GitHub release, or with `tags` or
`prereleases` to its newest matching version tag. When one moved and has an
`update` command, the command runs with the new tag and the tag is recorded
as reviewed. If only the pins changed, that's committed as
`Update <repo> to <tag>`, pushed to the default branch, and its CI watched.

If the update changed anything else, or the tool has no `update` command,
the release needs a review, so nothing is pushed for it. The repository is
logged with what to review, its `review` note and the release links, and the
run fails naming it, so a heal hands the review to an agent, which records
the tag once it's done.

Clones are kept in `upkeep/drift` in the XDG cache directory. Set
`UPKEEP_DRIFT_DRY_RUN=true` to log what would be pushed instead, without
failing for the reviews.
