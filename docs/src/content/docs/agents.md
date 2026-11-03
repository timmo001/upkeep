---
title: Agents
description: Let an agent read what Upkeep runs through its Code Mode tools, MCP server or CLI, with the upkeep skill.
---

Upkeep gives agents the same operations people get, from one list, following Groundwork's [behavior conventions](https://groundwork.timmo.dev/behavior):

| Surface   | How                                                         |
| --------- | ----------------------------------------------------------- |
| Code Mode | `upkeep agent tools --json` prints the manifest             |
| MCP       | `upkeep mcp` serves the operations on stdio                 |
| CLI       | Every command that returns data takes `--json`              |
| Skill     | `upkeep` tells an agent which to use, Code Mode first       |

| Operation | Access | Does                                                    |
| --------- | ------ | ------------------------------------------------------- |
| `status`  | Read   | Lists the jobs Upkeep runs                              |
| `runs`    | Read   | Lists runs on the server, newest first                  |
| `log`     | Read   | Prints a run's log                                      |
| `run`     | Write  | Queues a run, reusing one of the same job still waiting |

`runs`, `log` and `run` talk to the server in `UPKEEP_SERVER` as the admin in
`UPKEEP_ADMIN_TOKEN`. Managing tokens stays a CLI command for people, since it
hands out secrets.

## Skill

Install it with the [Skills CLI](https://skills.sh):

```bash
npx skills add timmo001/upkeep --skill upkeep
```

Or in Claude Code:

```text
/plugin install upkeep --marketplace timmo001/upkeep
```
