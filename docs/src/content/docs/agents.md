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

| Operation | Access | Does                       |
| --------- | ------ | -------------------------- |
| `status`  | Read   | Lists the jobs Upkeep runs |

There are no jobs yet, so `status` lists none. Each job adds its operations as it lands.

## Skill

Install it with the [Skills CLI](https://skills.sh):

```bash
npx skills add timmo001/upkeep --skill upkeep
```

Or in Claude Code:

```text
/plugin install upkeep --marketplace timmo001/upkeep
```
