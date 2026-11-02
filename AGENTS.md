# Upkeep

Keeps my repositories and their consumers up to date, and shows what needs
doing: a worker that runs jobs, and a web dashboard built on groundwork. The
plan is tracked in #1, with the working document attached to it; check it
before adding a new part. Open decisions are the issues labelled Needs
Decision, and work that depends on one waits for it.

## Stack

- Runtime, package manager and compiler: Bun.
- TypeScript with Effect v4. Read the installed `effect` source before writing
  Effect code, and prefer the Effect platform services from
  `@effect/platform-bun` over hand-written Node or Bun wrappers.
- Task runner: mise.

## Repository

- It's public. Nothing personal goes in: no home paths, machine or host names,
  private repo details or private config.
- Use mise-pinned tools and Bun. Keep `bun.lock` in sync with `package.json`,
  and pin dependencies to exact versions (`bun add -E`).
- Run project tasks through mise. Use `mise run format` and `mise run check`
  for validation.
- Keep source under `src/`, with the CLI tree in `src/index.ts` so help and
  completions come from one place.
- Use lowercase filenames for config and scripts, with kebab-case for
  multiword names. Effect modules are named after their service, such as
  `src/jobs/Runner.ts`.
- Use the shared `@timmo001/oxlint-rules/configs/recommended-effect` preset
  and its supported Oxlint peers.
- Track public work in issues with sub-issues and blocked-by relationships set;
  plans, research and decisions are attached to the issue.

## Rollout

Changes made here are pushed as they land, with no go-ahead needed. Once
`mise run check` passes for a change:

1. Commit the session's own changes through `dot git commit`, leaving other
   sessions' work alone, and push.
2. Tick the change off on its issue, with a link to the commit.
3. Report what landed and anything flagged.
