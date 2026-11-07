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

| Setting                     | Use                                                                         |
| --------------------------- | --------------------------------------------------------------------------- |
| `UPKEEP_SERVER_DB`          | Where the SQLite database lives                                             |
| `UPKEEP_SERVER_ADMIN_TOKEN` | An admin token of at least 32 characters, for the first admin commands      |
| `UPKEEP_HEALS_PER_DAY`      | How many heals a job can have for each target in any 24 hours, 3 by default |
| `UPKEEP_KEEP_DAYS`          | How many days finished runs and their logs are kept, 30 by default          |
| `UPKEEP_KEEP_RUNS`          | How many of each job's latest finished runs are kept however old, 20        |
| `UPKEEP_TRIAGE_URL`         | Triage's address, for the failure memory below; optional                    |
| `UPKEEP_TRIAGE_HOST_TOKEN`  | A triage host token, to send failures as events                             |
| `UPKEEP_TRIAGE_ADMIN_TOKEN` | A triage admin token, to read and resolve their issues                      |

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

## Status

```bash
upkeep status
upkeep status --json
upkeep status --bar-json
```

`upkeep status` is Upkeep's one status, from the server's `/api/status`, which
the bar, the OpenCode footer and agents all read, so each shows the same
count. It's `ok`, `warning` while anything needs you, or `degraded` while no
worker has asked for work in the last half hour. What needs you is each inbox
entry that needs a person, such as a heal that asked or a parked job, and each
skill change waiting for your approval, with the dashboard page to deal with
it. `--json` adds the `bar` and `footer` lines, and `--bar-json` prints only
the bar's: a wrench and the count, empty when nothing needs you, a tooltip
listing what does, and an `upkeep-<health>` class.

### Notifications

A worker with `notify` in its config file tells you when something new needs
you, and nothing else: no green runs, and decisions still go to the
Plannotator Inbox. Once a minute it reads the status and runs `command` for
each item it hasn't seen, with `{title}` and `{url}` (the item's dashboard
page) filled in. `dashboard` is where those pages are, `$UPKEEP_SERVER` by
default. The first read after the worker starts only records what's there, so
a restart doesn't repeat old notifications.

```json
{
  "notify": {
    "command": ["notify-send", "-a", "Upkeep", "{title}", "{url}"],
    "dashboard": "http://homeassistant.local:7272"
  }
}
```

## Dashboard

The server serves the dashboard at its root, such as
`http://127.0.0.1:7272/`. It asks for an admin token the first time and keeps
it in the browser.

It opens on the inbox: what changed in the tracked repositories and what
needs you, for when you haven't been watching. At the top, a few sentences
sum up what's new since you last read it: first-party releases and where they
went, your own commits, updates that needed a code change, how many routine
updates there were, and whether anything needs you. Plain code writes them,
with no agent; **Summarise in more detail** runs the `summary` job, which asks
an agent for a longer write-up of what's unread and shows it in the same card.
Below that:

- **Needs you** holds only what won't settle without you: a parked job, or a
  heal that asked for you or left a fix unfinished. Each comes once however
  often it happened, with the button that settles it, and goes once it's
  settled or dismissed.
- **What changed** is one entry per change, by day. A change that reached
  many repositories, such as a release rolled out by `bump`, a tool moved by
  `drift` or the same Renovate update, is one entry that opens to each
  repository and commit. Your own commits are grouped by repository and day.
- **Routine** folds every update that only moved versions, lockfiles, pins
  or tool versions into one line, which opens to the list.

An opened entry links to the job behind it and, while it's kept, the run.
An entry is unread until you open it or mark everything read, and comes back
unread when something new joins it. Read and dismissed entries are deleted 30
days after they last changed. The first time the server starts with the
inbox, it fills it from the commits runs pushed in the last 48 hours, and the
`watch` job adds the commits made outside Upkeep.

**Attention** is what needs you on GitHub, by section, with what changed
since you last looked on any device, and a Work, Personal or All filter. See
[Attention](#attention).

**Jobs** lists the jobs with their last run and whether they're parked or
paused, then the latest runs; press anywhere in a run's row to open it. Each
run shows its summary, its commits, its
heal record and its log, which follows the run as it goes. Jobs can be run,
paused or unparked, and runs cancelled, from there.

The inbox is `GET /api/inbox?days=7`. What happened in the last day, by run,
is `GET /api/activity?hours=24`, and the `activity` tool in MCP and Code Mode.

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

A worker runs jobs in five lanes at once, one run per lane, so a long job
doesn't hold up the others: heals in one, the quick API-only jobs
(`releases`, `watch`, `labels` and `notifications`) in another, the jobs that
clone and push to repositories in a third, where they take turns, what the
dashboard asks for, such as starting an agent, in a fourth, and the
[machine jobs](#machines) that keep the worker's own machine current in the
last. The command lane asks the server every few seconds, so a click is
picked up straight away.

On Arch, the `upkeep-git` package builds the binary from main and installs a
`upkeep-worker` user service. Put `UPKEEP_SERVER` and `UPKEEP_WORKER_TOKEN` in
`~/.config/upkeep/worker.env`, along with a `PATH` that finds the tools the
jobs use, such as `mise` and `opencode2`, then run
`systemctl --user enable --now upkeep-worker.service`.

Workers follow main and the server ships through releases, so a worker can be
older than the server. Each claim carries the worker's protocol, and the server
gives a worker older than itself no runs at all rather than one it can't read:
the worker logs that it's older than the server and needs `upkeep-git`
updated, and picks up work again once it is. Update the workers before a
release that raises the protocol.

A worker keeps its status in `$XDG_STATE_HOME/upkeep/worker-status.json`, or
`$UPKEEP_WORKER_STATUS`: a `health`, a one-line `summary` and when it was
`updated`. The summary says what's running, how the last run ended, which
jobs are parked and how many heals in the last day asked for a person, so a
service monitor can show more than that the process is up. It's `warning`
while anything needs a person and `degraded` while the server can't be
reached.

## Repositories

Jobs that work on repositories (`releases`, `labels`, `bump`,
`notifications`, `stalled-updates`, `drift`, `sync`, `deps` and `ci`) only touch the ones
the server tracks for them. Every other repository is left alone, and with
none tracked they do nothing. The `watch` job reads every tracked repository,
whatever it's opted into.

```bash
upkeep repos add owner/name
upkeep repos add owner/name --job bump --job labels
upkeep repos list
upkeep repos rename owner/name "System Bridge"
upkeep repos remove owner/name
```

`upkeep repos add` without `--job` opts a repository into every job that
works on repositories; with it, only the jobs given. Adding a repository again
replaces its jobs. A job added to Upkeep later stays off for repositories
already tracked until they're opted into it. Only the releases of
repositories tracked for `releases` count, and `bump` only rolls a release out
to consumers tracked for `bump`.

### Names

The dashboard shows each repository by its README's first heading, or its
own name when the README has none. Give one a name of your own with
`upkeep repos rename`, or Rename on its page in the dashboard, and leave the
name out to clear it again.

A worker can name them from your own list instead. Opt in with `names` in its
config file, a command that prints a JSON array of objects with `github`
(`owner/name`) and `name`:

```json
{
  "names": {
    "command": ["dot", "repo", "list", "--json"]
  }
}
```

The `watch` job runs it each time and names the tracked repositories it
lists. Give the command's full path when the worker runs as a service. A
name set by hand always stays; clear it and the worker's name shows again.

## Runs

```bash
upkeep run releases
upkeep run releases --local
upkeep run drift --repo timmo001/upkeep
upkeep runs --job releases --state failed
upkeep log <run> --follow
upkeep cancel <run>
upkeep retry <run>
upkeep dismiss <run>
upkeep runs --job heal
upkeep unpark <job>
upkeep pause heal
upkeep resume heal
```

`upkeep run` queues a run for a worker; a run of the same job and release
that's still waiting is reused instead. With `--local` it runs here instead,
printing its log and reporting nothing to the server. It still reads the
repositories tracked for the job from the server, so it needs `--server` and
an admin token.

`--repo owner/name` narrows a run to one repository: a job that works on
repositories only touches that one. It has to be tracked for the job, or
tracked at all for `watch`; a job that doesn't work on repositories refuses
it. A waiting run for the same repository, or for every repository, is reused,
so a burst of requests queues one run. Retrying a narrowed run keeps it
narrowed. The `run` tool in MCP and Code Mode takes the same `repo`.

`upkeep cancel` drops a queued run from the queue. A running one is marked
`cancelled`, and its worker stops it at its next heartbeat.

`upkeep retry` runs a finished run again: its job for the same release, or a
heal as the same heal, even when the job is parked. `upkeep dismiss` clears
what a run left for a person, and its inbox entry. Retrying a run dismisses
it too. The run page in the dashboard has the same buttons, and dismissing a
heal's inbox entry dismisses every heal it stands for.

`upkeep pause <job>` turns a job off without stopping the server or worker:
nothing queues it on its schedule, on releases or as a heal until
`upkeep resume <job>`, and runs of it already waiting stay in the queue
untaken. A run already going carries on, and it can still be run by hand.
Pausing `heal` stops every heal. The dashboard has the same switch on each
job.

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

A job gets `UPKEEP_HEALS_PER_DAY` heals for each target in any 24 hours, a
rolling window rather than the calendar day. A repository past that has its
heal held, while the job carries on for the others: the server queues it once
the repository's oldest heal is a day old, unless a later run of the job
reaches that repository first. The job's dashboard page lists the heals
waiting. A job failing in itself past that is parked instead. The server stops
queueing a parked job on its schedule or on releases, though it can still be
run by hand, and `upkeep status` lists it among what needs you, with the job's
page, which says why it's parked.
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
  asked for you is marked as needing you, and its heal's record keeps the
  session to pick it up from.
- `park` parks the job, with the model's reason.
- `ask` means the model isn't sure, so the last agent, the one for hard fixes,
  works on it as for `fix`.

A heal's run page shows its session as the `opencode2 --session` command
that resumes it, with a button to copy it and **Resume in Herdr**, which
opens it in the checkout the agent worked in, through a worker's
`attention.resume` (see [Attention](#attention)). When a heal ends with a
session that needs you, the worker shares it with the server
(`opencode session export`), so every worker with `attention.resume` gets a
button too; one that doesn't have the session imports it first. A session
that couldn't be shared only opens on the worker that ran it.

Every session the dashboard shows, a heal's or a skill change's, also has **Open here**, an `upkeep://open/<session>` link that opens
it on the machine the browser is on. The `upkeep-git` package registers the
link with `upkeep open`, which opens the session through that machine's
`attention.resume` as a worker would, importing it from the server (as the
admin in `admin.env`) when it ran elsewhere. Run it by hand with
`upkeep open <session>`.

The decision model and agents go in the worker's config file. The model is
any TypeSafe System One API at `url`, such as Ollaya or Ollama on the worker,
with `UPKEEP_DECISION_API_KEY` when it needs one, Clef on Cloudflare Workers
AI with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` and
`"provider": "cloudflare"`, or an LLM through OpenCode with
`"provider": "opencode"` and a `provider/model` model, for a worker without a
local model. `decisionsPerDay` caps how many heals a day the model chooses:
unlimited by default, 300 for `opencode`. Set one for a cloud model on a
shared or metered plan; past it, heals are left for you. The first agent is the default; with more than one, the model
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
Upkeep's own repository, for a heal that targets Upkeep.

`handOff` runs a command when a heal ends with a session that needs you,
such as a tool that parks it for another machine. It runs in the checkout the
agent worked in, with `{session}`, `{directory}`, `{name}` (the checkout's
folder) and `{title}` filled in. If it fails, the run log says so and the
heal still needs you:

```json
{
  "heal": {
    "handOff": {
      "command": ["park-session", "{session}", "{directory}"]
    }
  }
}
```

Without a decision model, a lost run is retried and anything else is left for
you: the run is marked as needing attention on the dashboard, and its
repository's items on the Attention page show it.

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

## Jobs

| Job                 | Runs             | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `releases`          | Every 30 minutes | Reads the latest release of each repository I own tracked for it, skipping forks and archived ones, and queues the jobs that run on a new one. A first sighting is only recorded.                                                                                                                                                                                                                                                                                          |
| `watch`             | Every 15 minutes | Reads the last 48 hours of commits on each tracked repository's default branch and adds the ones the inbox doesn't have: your own, merged Renovate and Dependabot updates, and anyone else's. A commit that only moves versions, lockfiles, pins, submodules or tool versions is marked routine, and so is a bot's commit that touches no source code. It also reads each repository's title, and its [name](#names) when the worker opts in. See [Dashboard](#dashboard). |
| `labels`            | Daily at 04:00   | Brings each repository's labels in line with groundwork's conventions. Old names are renamed in place through aliases, so issues keep their labels. A label the conventions don't know is deleted when nothing uses it, and otherwise left and listed in the log.                                                                                                                                                                                                          |
| `bump`              | On a new release | Rolls the release out to the repositories that use it, found through code search: workflow and action pins of the released repository, and `package.json` dependencies on the packages it publishes. Each one is checked, pushed to its default branch and its CI watched.                                                                                                                                                                                                 |
| `heal`              | On a failed run  | Fixes a failed or lost run: retries it, hands it to an agent, parks the job or asks. See [Heals](#heals).                                                                                                                                                                                                                                                                                                                                                                  |
| `notifications`     | Every 15 minutes | Dismisses unread GitHub notifications for Renovate and Dependabot pull requests that have merged, and logs each one. A thread that changed since it was read is left, and anything else stays unread.                                                                                                                                                                                                                                                                      |
| `stalled-updates`   | Hourly           | Takes over Renovate and Dependabot pull requests whose checks failed: squashes each onto the default branch, checks it, pushes it and closes the pull request. See [Stalled updates](#stalled-updates).                                                                                                                                                                                                                                                                    |
| `drift`             | Every 6 hours    | Checks each repository's `tooling.yml` against the latest releases of its tools, pushes the pin moves that need no review, and fails with what to review for the rest. See [Drift](#drift).                                                                                                                                                                                                                                                                                |
| `drift-review`      | On request       | Hands each repository tracked for `drift` to an agent, through a heal, to review as a whole against the current release of every tool in its `tooling.yml`: what it's still missing, not only what changed since the last review. See [Drift](#drift).                                                                                                                                                                                                                     |
| `sync`              | Hourly           | Runs groundwork's sync over the apps with a `sync.json`: carries their QML edits back to groundwork, copies its changes out, then checks and pushes each one. See [Sync](#sync).                                                                                                                                                                                                                                                                                           |
| `deps`              | Every 6 hours    | Reads each repository's Renovate config, presets and all, without running Renovate, and logs the groups of updates it would open with who owns each: Renovate when it runs and automerges the group, otherwise Upkeep. In the repositories set to apply, it applies, checks and pushes Upkeep's groups, as a dry run by default.                                                                                                                                           |
| `ci`                | Hourly           | Reads the latest CI on each repository's default branch, runs the checks of a red one here and fails with both, so a heal fixes it forward. See [CI](#ci).                                                                                                                                                                                                                                                                                                                 |
| `skill-consumers`   | Hourly           | Syncs the shared skills into the repositories listed in the skills repository's `consumers.yml`, through its own `skill-maintenance`. See [Skills](#skills).                                                                                                                                                                                                                                                                                                               |
| `skill-updates`     | Hourly           | Pushes the shared skills' updates that need no review, and starts a `skill-change` for each that needs an agent. See [Skills](#skills).                                                                                                                                                                                                                                                                                                                                    |
| `skill-change`      | On request       | Has an agent change a skill and holds its commit as a patch for your approval, or lands, revises or starts again on a held change, or opens an agent on one. See [Skills](#skills).                                                                                                                                                                                                                                                                                        |
| `summary`           | On request       | Asks the first of the worker's `heal.agents` for a longer write-up of the unread inbox, or all of it when everything's read, through OpenCode. The write-up is the run's summary, which the inbox shows. See [Dashboard](#dashboard).                                                                                                                                                                                                                                      |
| `attention`         | Every 15 minutes | Reads the open pull requests, issues and notifications that involve you, the open ones on tracked repositories and the worker's own searches, with GitHub's signals for each, for the Attention page. See [Attention](#attention).                                                                                                                                                                                                                                         |
| `attention-context` | Every 3 hours    | Asks an agent for a note on each Attention item that changed, a follow-up on groups whose items went, and what to do about your comments. A comment also queues it. See [Attention](#attention).                                                                                                                                                                                                                                                                           |
| `command`           | On request       | Does one thing the dashboard asks, such as mark a notification read. A failed command shows on its run and is never healed.                                                                                                                                                                                                                                                                                                                                                |
| `up-dotfiles`       | Hourly           | Pulls the dotfiles on every worker, rebuilds `dot` and stows them. See [Machines](#machines).                                                                                                                                                                                                                                                                                                                                                                              |
| `up-skills`         | Hourly           | Moves every worker's shared skills to the latest main and relinks them, reloading agents when they changed. See [Machines](#machines).                                                                                                                                                                                                                                                                                                                                     |
| `up-repos`          | Every 30 minutes | Pulls the tracked repositories on every worker that are behind and have no work in progress. See [Machines](#machines).                                                                                                                                                                                                                                                                                                                                                    |
| `up-tools`          | Daily at 05:10   | Installs and upgrades every worker's mise tools. See [Machines](#machines).                                                                                                                                                                                                                                                                                                                                                                                                |
| `up-plugins`        | Daily at 05:20   | Updates every worker's agent plugins, reloading agents when they changed. See [Machines](#machines).                                                                                                                                                                                                                                                                                                                                                                       |

With [GitHub events](/events) set up, `bump`, `watch`, `sync`, `deps`,
`drift`, `ci` and `skill-consumers` also start seconds after the release,
push or workflow run that concerns them, and the schedules above catch what
an event misses.

The `labels` job reads the conventions from a groundwork checkout, set by
`UPKEEP_GROUNDWORK` on the worker, running its CLI with the checkout's pinned
Bun through `mise exec`.

### Machines

The `up-*` jobs keep each worker's own machine current, so nobody has to run
`dot up` for the parts that need no root. Each runs one `dot up` stage
headless, `dot up <stage> --json`, and reads what it did from the JSON it
prints. Unlike the other jobs, they run once on every worker that asked for
work in the last half hour rather than once overall: the server queues a run
for each worker whose latest run of the job is older than the job's last
scheduled time. It checks once a minute, so a worker that was off catches up
when it comes back, and running a job by hand queues it on every live worker.

A dotfiles pull is applied by `dot up stow` straight after it. When a stage
changed skills or agent plugins, the job runs `dot up agents` after it, which
reloads running agents. A worker without `dot` skips them. A
failed stage fails its run, which shows on the dashboard and is never healed.
The Jobs table shows each worker's latest run of each one.

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
directory and reused. Before a clone is reused, as by every job that keeps
clones, empty Git lock files over an hour old are removed from it and its
submodules, so a Git command cut off once, such as by a restart, doesn't fail
every run after it.

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

### Deps

In the repositories listed in `deps.apply` in the worker's config file, the
`deps` job also applies each group of updates Upkeep owns, one at a time: it
edits the `package.json`, mise config, workflow, or custom regex or jsonata
match the
update was read from, installs where a `package.json` changed, runs
`mise lock` where a mise config with a `mise.lock` changed, and checks the
result as a bump does (with the same per-repository checks). The checked
commit is pushed to the default branch and its CI watched, and once CI
passes Renovate's open pull request for the group is closed with a link to
the commit. Groups Renovate automerges are left to it, and so is a group with
an update Upkeep can't apply yet, such as a lockfile-only one, with a
warning. A group that fails is logged and left while the rest go on. After a
repository's updates land, its `tooling.yml`, if it has one, is checked as
`drift` would, so a tool bump and its review go out together. The run fails
at the end naming each repository with a failed group, and a heal for each
one applies that group by hand, migrating what the new versions need. Clones
are kept in `upkeep/deps` in the XDG cache directory, with their submodules.

Git submodules are read when the config turns on Renovate's `git-submodules`
manager. Each submodule follows its `.gitmodules` branch, or its remote's
default branch, and an update checks out the new commit. A config's
`customDatasources` are fetched in their format (`json`, `plain`, `yaml` or
`toml`) and run through their JSONata transforms, as Renovate does.

To hand a repository over to Upkeep entirely, set `"enabled": false` at the
top of its Renovate config. Renovate then stops, and Upkeep keeps reading the
rest of the config and owns every group, including the ones Renovate would
have automerged.

Applying is a dry run by default, logging what would be pushed. Set
`deps.dryRun` to `false` to push:

```json
{
  "deps": {
    "apply": ["owner/name"],
    "dryRun": false
  }
}
```

### Attention

The `attention` job reads what involves you on GitHub and sends it all to the
server, which sorts each item into a section by its signals, with no model:

- **Needs you:** a review requested, changes requested, unresolved threads,
  a mention, or a reply from someone else in the last `staleDays`. Your own
  pull request is here too once it's approved, or ready to merge: its checks
  pass with no conflicts, and no review is asked of anyone else.
- **Blocked:** your own, with failing checks, conflicts, or an Upkeep finding
  for its repository. A base branch that moved under its files shows as a
  signal, but doesn't block on its own.
- **Going stale** (no activity for `staleDays`) and **Waiting on others**:
  the rest of your own.
- **Your backlog** (your drafts, and your issues nobody else has joined) and
  **Watching** (everyone else's), folded away.

On your own items, the shared status labels say more: **Needs Decision** puts
one under Needs you, **In Progress** keeps it out of the backlog, and
**Blocked**, **On Hold** or **Future** puts it there, since a Blocked label
waits on something else rather than on a fix. The backlog is ordered by
status: In Progress, Ready and Planned first, then unlabelled items, with
Blocked, On Hold and Future last. Each item shows its
status and type labels, and the latest release of each repository with
something on the page is folded away under **Latest releases**.

Items that belong to one piece of work show together as a group. The job
reads how they tie together on GitHub (stacked pull requests, the issues a
pull request closes, parents, sub-issues and blockers) and the server forms a
group from each set. You can also move an item into a group of your own from
its Group menu, which GitHub's links then leave alone. A group sits in the
section of its most urgent item, or set its focus to **Today** to pin it at
the top, or **Parked** to fold it away. Its menu adds an outside wait, such as
a release next month, or renames it.

Each run sends the full set, and the server only logs what moved since the
last one, which **Since you last looked** shows. What closed or no longer
involves you is kept apart, folded away under **Gone** as a history of the
last week. Opening the page, or its
Refresh button, queues a run when the last one is more than 5 minutes old;
until then, the button is disabled and says how long is left. Notifications and base branches
are read conditionally, so a quiet run costs little.

The `attention-context` job runs an agent over the page every three hours,
and only on what changed since its last look: items in the urgent sections,
or in a group pinned for Today, whose note is missing or older than their last
change. It reads each item's description and latest comments and writes a
one-line note on where it stands. A note with a recheck date, such as a wait
for next month's release, keeps the item out of Going stale until then, or
until the item changes. When an item in a group closes, it writes a follow-up
on the group, such as an issue to close now. It may suggest a group for an
item, which you accept or dismiss. Each item's and group's **Comment** tells
the agent something, which queues a run; its answer shows under your comment,
and a standing instruction becomes one of the **Agent rules**, which every
run follows.

**Start agent** on an item or a group opens an agent on it, with an optional
prompt, in a repository you pick: the ones its items are on are suggested
first, Upkeep is always there to move or sort issues from, and every other
tracked repository follows. It starts on the worker used last in that
browser, with the others that can offered in the menu. The worker writes a
brief of where it stands: its signals and description, unresolved review
threads with their file and line, failing checks with the end of their logs,
the issues it closes, the rest of its group, the context agent's notes,
outside waits and your comments. It then runs its `attention.launch` command
in the repository's checkout, which opens the agent with the brief. Until it
has, the item shows how it's going: waiting for the worker, starting, then
started or why it couldn't, with a link to the run. Each group card also
folds down to its heading, remembered in that browser.

The `attention` section of the worker's config file sets the rest. `searches`
are extra GitHub searches, with `{since}` replaced by the date `staleDays`
ago. Items on a `work` site count as work, `exclude` sites are left out, and
so are items carrying one of `ignoreLabels`. `workTime.command` prints
`{ "work": true }` during work time, so the page opens on Work or Personal to
match, or All without it. `agent` is the OpenCode model the context job runs
on, best a quick one, or the first of `heal.agents` without it. `launch`
lets the worker start agents: `command` runs in the checkout with `{brief}`
(the brief's file), `{directory}`, `{repo}`, `{name}` and `{title}` filled
in, and `directory` is where your checkouts are, with `{owner}` and `{name}`;
a repository with no checkout there is cloned into the cache. `resume` lets
the worker open an agent's OpenCode session from a heal's run page or a skill
change: `command` runs in the directory the agent worked in, with
`{session}`, `{directory}`, `{name}` (the directory's last folder) and
`{title}` filled in. A heal session another worker shared is imported first,
into the same directory when it's on this worker too, or else into the
checkout `launch.directory` finds:

```json
{
  "attention": {
    "searches": ["org:some-org is:pr is:open updated:>={since}"],
    "work": ["github.com/some-org", "*.example.com"],
    "exclude": ["github.com/owner/name"],
    "ignoreLabels": ["wontfix"],
    "staleDays": 14,
    "workTime": { "command": ["work-time-check"] },
    "agent": { "model": "provider/model", "variant": "high" },
    "launch": {
      "command": ["open-agent", "--prompt-file", "{brief}", "{directory}"],
      "directory": "~/repos/{name}"
    },
    "resume": {
      "command": ["open-pane", "{directory}", "opencode2 --session {session}"]
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

`drift` only sees what changed since the release last reviewed, so a
repository can still be behind on what its tools already had. Run
`drift-review` for that, on request only, so its findings never repeat on their
own:

```bash
upkeep run drift-review --repo timmo001/system-bridge
```

For each tool, it logs a review of the whole repository against the tool's
current release, with the tool's `review` note: features, commands, flags and
config options it doesn't cover yet, and snapshots or derived files that no
longer match. The repository's run then fails, and a heal hands it to an
agent, which adds what's missing or says nothing is. Without `--repo` it
reviews every repository tracked for `drift`; it has no opt-in of its own.

Clones are kept in `upkeep/drift` in the XDG cache directory. Set
`UPKEEP_DRIFT_DRY_RUN=true` to log what would be pushed instead, without
failing for the reviews.

### Sync

Every hour the `sync` job finds the signed-in account's repositories with a
[`sync.json`](https://groundwork.timmo.dev/sync) at their root, the apps that
take copies of groundwork's items, such as its QML panel components. It
clones groundwork and each app, and runs groundwork's own sync over them.

An app's edit to a QML copy is carried back into groundwork, then every
changed source is copied out to the apps that take it. Carried-back edits are
checked and pushed to groundwork first, so no app gets a copy groundwork
doesn't have. Each changed app is then checked as `bump` checks a consumer,
pushed to its default branch and its CI watched.

A copy edited in the app and changed in groundwork too, or edited differently
in two apps, is left alone and fails its app, so a heal hands it to an agent
to move the edit into groundwork or a wrapper.

Clones are kept in `upkeep/sync` in the XDG cache directory. Set
`UPKEEP_SYNC_DRY_RUN=true` to log what would change instead, without changing
anything.

### Skills

The skill jobs run the shared skills repository's own `skill-maintenance`,
the signed-in account's `skills`, so its upkeep runs once on a worker rather
than on a timer on every machine. Each run clones the repository's default
branch into `upkeep/skills` in the XDG cache directory and builds
`skill-maintenance` there, so it always runs the latest pushed version, and
its output goes to the run's log as it's written.

Every hour, `skill-consumers` runs `skill-maintenance consumers`, which adds,
updates and removes the skill copies of each repository listed in
`consumers.yml` and pushes them to its default branch.

Every hour, `skill-updates` reads `skill-maintenance updates --json` and
`skill-reviews --json`. Imports with no local edits, including those that
only move their pinned SHA, are applied with `updates --update`, checked with
`mise run validate`, then committed and pushed straight to the default branch.
Imports that follow one tool release land together, as `Update <repo> to
<tag>`. An import that fails validation is reset and left out.

What needs an agent, such as upstream changes to merge into a skill's local
edits or a skill to review against a new tool release, starts a run of the
`skill-change` job, unless a change for it is still open. The agent works in
its own checkout under `upkeep/skills/changes` and commits once, without
pushing. A commit that only moves pins in `skills.yml`, reviewed tags or
upstream SHAs, is pushed straight away; anything else is kept on the server as
a patch, waiting for your approval, and an open change for the same skill
waiting before it is dropped. Problems no agent can settle, such as an
upstream that's gone, fail the run.

Approving a change lands it on any worker, from a fresh checkout: the patch is
applied, validated with `mise run validate` (or `check`) and pushed. One that
no longer applies or validates is marked stale. Asking for changes resumes the
agent's session on its own worker, or, with that worker down, starts again on
any worker from the held patch.

The agent is the worker's `skills.agent`, a model and optional variant, or
else the first of `heal.agents`, with `skills.sessionMinutes` (30 by default)
to finish:

```json
{
  "skills": {
    "agent": { "model": "provider/model", "variant": "high" },
    "sessionMinutes": 30
  }
}
```

The dashboard's Skills page shows the held changes with their diffs. Approve
lands one, Request changes resumes its agent with your comment (Resume) or
starts again on any worker (Start again), Drop leaves it, and Open in Herdr
opens an agent in its checkout through the worker's `attention.launch`, when
that worker is up and has one. A change made by an agent shows its session
too, to copy or Resume in Herdr as a heal's is. Below them is every skill: where it comes from,
how it stands against its upstream and the tools it covers, which
repositories keep a copy and its last commits, with Ask for a change to start
an agent on it. `skill-updates` sends what it read of the shared repository
after each run, and the skills of any repositories in `skills.repos`, each
with the folder holding them:

```json
{
  "skills": {
    "repos": [{ "repo": "owner/dotfiles", "path": ".agents/skills" }]
  }
}
```
