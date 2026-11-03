---
name: upkeep-packages
description: Structure and conventions for Upkeep's Bun workspace packages under packages/. Use when adding a package, moving code between packages, adding a dependency or CLI command, or changing a package's tsconfig, oxlint config or scripts.
license: Apache-2.0
compatibility: Needs mise and Bun from the upkeep repository root.
---

# Upkeep packages

- Each part is a private Bun workspace package under `packages/<name>/`,
  named `@upkeep/<name>`. Nothing is published.
- Keep every package portable: its own `package.json` with the dependencies
  and the lint, typecheck and test scripts it needs, its own `tsconfig.json`
  and `oxlint.config.ts`, and source in its own `src/`.
- Packages use each other through `workspace:*` dependencies and public
  exports, never relative imports across packages.
- Add dependencies with `bun add -E` in the package, and keep `bun.lock` in
  sync.
- The CLI is `packages/cli`, with the whole command tree in its
  `src/index.ts`, so help and completions come from one place.
- Lint with the shared `@timmo001/oxlint-rules/configs/recommended-effect`
  preset and its supported Oxlint peers, with type checking on. Fix a type
  error rather than turning a check off; each package's `src/types/` holds
  declarations for dependencies that ship none.
- `mise run lint` runs Oxlint per package; `mise run check` runs it with
  typecheck, format and docs checks.
