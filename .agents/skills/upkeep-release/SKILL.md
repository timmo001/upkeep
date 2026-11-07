---
name: upkeep-release
description: Release Upkeep's Home Assistant app and roll it out, from the version bump and changelog to installing it on Home Assistant through the ha-bridge Code Mode tools. Use when a change needs the server or dashboard to pick it up (a new job in the catalogue, a server or dashboard change), when bumping home-assistant/app/config.yaml, publishing a release, debugging the Release workflow, or updating the installed app.
license: Apache-2.0
compatibility: Needs mise, Bun and the gh and ha-bridge Code Mode tools, from the upkeep repository root.
---

# Releasing Upkeep

The Home Assistant app runs the server and dashboard; workers run from the
`upkeep-git` package. A change only the worker or CLI uses needs no release,
since `publish-arch-git.yml` publishes `upkeep-git` on each push to `main`. A
change the server serves, such as a job added to `packages/api`'s catalogue or
anything in the server or dashboard, needs one.

Releases are part of this repository's rollout and need no go-ahead.

## Release

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
   timmo001/home-assistant-apps. Check that repository's Update app run
   succeeded before installing.

## Install

Install through the `ha-bridge` Code Mode namespace, not the CLI or SSH:

1. `check_updates` with `target: { entity_id: "update.upkeep_update" }`, so
   the Supervisor reloads the app store.
2. `get_update` on `update.upkeep_update`: the latest version is the new one
   and the release notes are yours.
3. `call_action` with `action: "update.install"` on the same target.
4. `get_updates` on it: installed and latest match, nothing in progress.
5. `upkeep.jobs` lists what the release added, such as a new job, and
   `upkeep.status` shows the server healthy with its workers live.

Workers lose the server for a minute while the app restarts. They retry on
their poll interval, so a worker log warning about a refused connection then
is expected; check its next claim succeeds.

Only `update.upkeep_update` is installed this way. Any other Home Assistant
update still needs the user's go-ahead.
