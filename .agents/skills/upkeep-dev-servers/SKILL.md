---
name: upkeep-dev-servers
description: Run, check and stop Upkeep's CLI, server and docs dev processes through the serve:* mise tasks and Pitchfork. Use before starting any Upkeep dev process, for a one-off run of the built binary, or when a *.upkeep.localhost address doesn't resolve.
license: Apache-2.0
compatibility: Needs mise and Pitchfork from the upkeep repository root.
---

# Upkeep dev servers

Start dev processes with the `serve:*` tasks, never in the foreground. Each
has `status`, `logs`, `restart` and `stop` tasks beside it, such as
`serve:cli:status`.

| Task           | Runs                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `serve:cli`    | The CLI in watch mode. Don't run `mise run dev`: it never exits.                                                                |
| `serve:docs`   | The docs site at `https://docs.upkeep.localhost`. Don't run `mise run docs:dev`.                                                |
| `serve:server` | The server in watch mode at `https://server.upkeep.localhost`, with a throwaway database in `.dev/` and the admin token in `pitchfork.toml`. |

For a one-off run, `mise run build` and run `./dist/upkeep`.

Servers get a daemon with a port, reached at
`https://<daemon>.upkeep.localhost` through the Pitchfork proxy. Never add
the proxy's own port, such as `:8443`: run `pitchfork proxy doctor`, then
`pitchfork proxy setup`, to restore the 443 redirect instead.
