---
name: upkeep
description: Read and start Upkeep's runs from an agent. Use when asked which jobs Upkeep has, how a run went, why one failed, or to run a job.
---

# Upkeep

Prefer the `upkeep` Code Mode namespace, then the MCP server (`upkeep mcp`); fall back to the CLI with `--json`. Server operations need `UPKEEP_SERVER` and `UPKEEP_ADMIN_TOKEN`.

- `upkeep status --json` lists the jobs Upkeep runs.
- `upkeep runs --json` lists runs, newest first; filter with `--job` and `--state failed`.
- `upkeep log <run> --json` prints a run's log as JSON lines. A failed run's `error` holds why it failed.
- `upkeep run <job>` queues a run (write). `upkeep run <job> --local` runs it on this machine and reports nothing, which is the safe way to try a job.
- `upkeep agent tools --json` prints every operation with its input schema and how an agent may use it; `upkeep agent call <tool>` runs one with JSON input on stdin.

Token commands (`upkeep admins`, `upkeep workers`) hand out secrets: leave them to the person.
