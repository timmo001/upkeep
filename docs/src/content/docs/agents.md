---
title: Agents
description: Let an agent read what Upkeep runs through its Code Mode tools, MCP server or CLI, with the upkeep skill.
---

Upkeep gives agents the same operations people get, from one list, following Groundwork's [behavior conventions](https://groundwork.timmo.dev/behavior). The operations are the MCP server's tools, and Code Mode runs those same tools through the binary:

| Surface   | How                                                                         |
| --------- | --------------------------------------------------------------------------- |
| Code Mode | The OpenCode plugin adds the `upkeep` namespace from the manifest           |
| MCP       | `upkeep mcp` serves the operations on stdio                                 |
| CLI       | Every command that returns data takes `--json`                              |
| Skill     | `upkeep` tells an agent which to use, Code Mode first                       |

`upkeep agent tools --json` prints the manifest: each tool's input schema and
access, in the shape `dot agent tools --json` prints. `upkeep agent call <tool>`
runs one with its input as JSON on stdin and prints its result as JSON.

| Operation | Access | Does                                                    |
| --------- | ------ | ------------------------------------------------------- |
| `status`  | Read   | Says what needs you, the parked jobs and live workers   |
| `jobs`    | Read   | Lists the jobs Upkeep runs                              |
| `runs`    | Read   | Lists runs on the server, newest first                  |
| `log`     | Read   | Prints a run's log                                      |
| `run`     | Write  | Queues a run, reusing one of the same job still waiting |
| `cancel`  | Write  | Drops a queued run, or stops a running one              |
| `retry`   | Write  | Runs a finished run again, a heal as the same heal      |
| `dismiss` | Write  | Clears what a run left for a person                     |
| `unpark`  | Write  | Lets a parked job be queued again                       |
| `pause`   | Write  | Turns a job off until it's resumed                      |
| `resume`  | Write  | Turns a paused job back on                              |

`status`, `runs`, `log`, `run`, `cancel`, `retry`, `dismiss`, `unpark`, `pause` and `resume` talk to the server in `UPKEEP_SERVER` as the admin in
`UPKEEP_ADMIN_TOKEN`, from the environment or `~/.config/upkeep/admin.env`.
Managing tokens stays a CLI command for people, since it
hands out secrets.

## OpenCode plugin

The plugin in `packages/opencode` reads the manifest from the `upkeep` on your
`PATH`, so its tools always match the binary. Write tools ask first, under the
`upkeep.write` permission. Add it to your global OpenCode config:

```jsonc
{
  "plugins": ["github:timmo001/upkeep#main::path:packages/opencode"],
}
```

## Skill

Install it with the [Skills CLI](https://skills.sh):

```bash
npx skills add timmo001/upkeep --skill upkeep
```

Or in Claude Code:

```text
/plugin install upkeep --marketplace timmo001/upkeep
```
