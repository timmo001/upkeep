---
name: upkeep-release
description: Roll an Upkeep change out to the server, dashboard and workers, and release Upkeep's Home Assistant app and binaries. Use after pushing a change to main that the server, dashboard or workers need (a new job in the catalogue, a server or dashboard change), to check or force the server's update, when bumping home-assistant/app/config.yaml, publishing a release, or debugging the Publish Arch git package or Release workflows.
license: Apache-2.0
compatibility: Needs mise, Bun and the gh and upkeep Code Mode tools, from the upkeep repository root.
---

# Rolling out and releasing Upkeep

The server and dashboard run from the `upkeep-git` Arch package under
`upkeep-server.service`, on the always-on machine that also runs a worker
(the private machine notes name it). Workers run from `upkeep-git` too, or
from a release's `upkeep-linux-x64` and `upkeep-linux-arm64` binaries through
mise on machines without it.

So a push to `main` is what updates the server, the dashboard and the
`upkeep-git` workers, with no release. A release only matters for the Home
Assistant app, which is no longer what runs the server, and for mise-installed
workers.

## After a push

`publish-arch-git.yml` builds `upkeep-git` on each push to `main` that changes
the binary. A successful build queues `first-party` on every worker, which
upgrades the package; its install script restarts `upkeep-server.service` and
drains the worker onto the new binary. Check it landed for every change the
server or dashboard serves, such as a job added to `packages/api`'s catalogue
or anything in the server or dashboard:

1. Watch the Publish Arch git package run for the pushed commit in a
   background shell with `gh run watch <id> --exit-status`.
2. Read `upkeep.runs` with `job: "first-party"`. The server machine's worker's
   latest run should say it upgraded `upkeep-git` to a version with
   `.g<short sha>` of the pushed commit or a later one in it, such as
   `0.0.0.r741.g31886aa-1`.
3. If it hasn't run since the build, or failed, force it with
   `upkeep.run({ job: "first-party" })`, then read the runs again.
4. `upkeep.status` shows the server healthy with its workers live, and
   `upkeep.jobs` lists anything the change added, such as a new job.

Workers lose the server for a few seconds while it restarts. They retry on
their poll interval, so a worker log warning about a refused connection then
is expected.

## Release

Release when a change should reach the Home Assistant app or mise-installed
workers. Releases are part of this repository's rollout and need no go-ahead.

1. Set `version` in `home-assistant/app/config.yaml`. The Release workflow
   fails unless the tag matches it exactly, with no `v`.
2. Run `mise run check`, commit `Release <version>` through `dot git commit`
   and push.
3. Write the changelog in full from `git log <last tag>..HEAD`, grouped by
   area (Jobs, Dashboard, Server, CLI, Internals), each entry saying what
   changed for someone running Upkeep. End with
   `**Full Changelog**: https://github.com/timmo001/upkeep/compare/<last>...<version>`.
   Never ship generated or one-line notes.
4. Create the release with `gh.release_create`, tag and title the bare
   version, `target` the release commit's full SHA.
5. Watch the Release run in a background shell with
   `gh run watch <id> --exit-status`. It builds the image per architecture,
   pushes the manifest to `ghcr.io/timmo001/upkeep-app`, then dispatches to
   timmo001/home-assistant-apps; check that repository's Update app run
   succeeded. Beside the image it builds the binary for each architecture and
   attaches `upkeep-linux-x64`, `upkeep-linux-arm64` and `SHA256SUMS`; check
   `gh.release_view` lists all three.

Don't install or start the Home Assistant app as part of a rollout: it isn't
what runs the server, and starting it would run a second server.
