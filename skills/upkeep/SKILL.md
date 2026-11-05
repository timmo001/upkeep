---
name: upkeep
description: Read, start, retry and cancel Upkeep's runs from an agent. Use when asked which jobs Upkeep has, how a run went, why one failed, to run a job, to run a failed run or heal again, to dismiss one or to cancel a run.
---

# Upkeep

Prefer the `upkeep` Code Mode namespace, then the MCP server (`upkeep mcp`); fall back to the CLI with `--json`. Server operations need `UPKEEP_SERVER` and `UPKEEP_ADMIN_TOKEN`.

- `upkeep status --json` lists the jobs Upkeep runs.
- `upkeep runs --json` lists runs, newest first; filter with `--job` and `--state failed`.
- `upkeep log <run> --json` prints a run's log as JSON lines. A failed run's `error` holds why it failed.
- `upkeep run <job>` queues a run (write). `upkeep run <job> --local` runs it on this machine and reports nothing, which is the safe way to try a job.
- `upkeep cancel <run>` drops a queued run or stops a running one (write).
- `upkeep retry <run>` runs a finished run again, a heal as the same heal, and dismisses the old one (write). `upkeep dismiss <run>` clears what a run left for a person and its inbox entry (write).
- `upkeep runs --job heal` lists heals: what each one heals, what was decided and what was done (read).
- `upkeep unpark <job>` lets a parked job be queued again (write). With triage set up, resolving the job's triage issue unparks it too.
- `upkeep repos list --json` lists the repositories Upkeep works on and the jobs each is opted into (read). `upkeep repos add <owner/name>`, with `--job` to opt into only some jobs, and `upkeep repos remove <owner/name>` change them (write).
- `upkeep agent tools --json` prints every operation with its input schema and how an agent may use it; `upkeep agent call <tool>` runs one with JSON input on stdin.

Token commands (`upkeep admins`, `upkeep workers`) hand out secrets: leave them to the person.
