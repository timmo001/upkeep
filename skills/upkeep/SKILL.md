---
name: upkeep
description: Read, start and cancel Upkeep's runs from an agent. Use when asked which jobs Upkeep has, how a run went, why one failed, to run a job or to cancel a run.
---

# Upkeep

Prefer the `upkeep` Code Mode namespace, then the MCP server (`upkeep mcp`); fall back to the CLI with `--json`. Server operations need `UPKEEP_SERVER` and `UPKEEP_ADMIN_TOKEN`.

- `upkeep status --json` lists the jobs Upkeep runs.
- `upkeep runs --json` lists runs, newest first; filter with `--job` and `--state failed`.
- `upkeep log <run> --json` prints a run's log as JSON lines. A failed run's `error` holds why it failed.
- `upkeep run <job>` queues a run (write). `upkeep run <job> --local` runs it on this machine and reports nothing, which is the safe way to try a job.
- `upkeep cancel <run>` drops a queued run or stops a running one (write).
- `upkeep runs --job heal` lists heals: what each one heals, what was decided and what was done (read).
- `upkeep unpark <job>` lets a job parked after too many heals be queued again (write).
- `upkeep agent tools --json` prints every operation with its input schema and how an agent may use it; `upkeep agent call <tool>` runs one with JSON input on stdin.

Token commands (`upkeep admins`, `upkeep workers`) hand out secrets: leave them to the person.
