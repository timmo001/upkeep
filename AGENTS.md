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
- Open each hand-written source file with a short header comment saying what
  it is and, where it isn't obvious, why it's there: a `/** */` block before
  the imports in TypeScript, the file's own comment syntax elsewhere. Skip
  generated files, data files and one-line configs.
- Use the shared `@timmo001/oxlint-rules/configs/recommended-effect` preset
  and its supported Oxlint peers, with type checking on. Fix a type error
  rather than turning a check off; `src/types/` holds declarations for
  packages that ship none.
- Track public work in issues with sub-issues and blocked-by relationships set;
  plans, research and decisions are attached to the issue. Ideas and feature
  requests go to Discussions where a repo has them on. Private work can stay in
  whatever tool fits until it lands on a public repo.

## Development

- `mise run dev` runs in watch mode and never exits. Don't run it in the
  foreground from an agent; use `mise run build` and run `./dist/upkeep`
  instead.
- CI runs `mise run check`, `test` and `build` through the shared Bun CLI
  workflow, then smoke-tests the binary, plus the shared lint workflows. The
  hk pre-push hook runs the same lint steps; run them by hand with
  `hk check --all`.

## Rollout

Changes made here are pushed as they land, with no go-ahead needed. Once
`mise run check` passes for a change:

1. Commit the session's own changes through `dot git commit`, leaving other
   sessions' work alone, and push.
2. Tick the change off on its issue, with a link to the commit.
3. Report what landed and anything flagged.
