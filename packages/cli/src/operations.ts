/**
 * How an agent may use each operation, following Groundwork's behavior
 * conventions: https://groundwork.timmo.dev/behavior. The operations
 * themselves are the MCP tools in `mcp.ts`; Code Mode and MCP both read this.
 */
import { Record, Schema } from "effect";
import type { Tools } from "./mcp";

export const Access = Schema.Literals(["read", "write", "ask", "power"]);

export type Access = typeof Access.Type;

export type ToolName = keyof typeof Tools.tools;

export const access = {
  status: "read",
  jobs: "read",
  runs: "read",
  activity: "read",
  log: "read",
  run: "write",
  cancel: "write",
  retry: "write",
  dismiss: "write",
  unpark: "write",
  pause: "write",
  resume: "write",
  repos: "read",
  track: "write",
  rename: "write",
  untrack: "write",
  inbox: "read",
  inbox_move: "write",
  inbox_rules: "read",
  inbox_rule: "write",
} satisfies { readonly [Name in ToolName]: Access };

/** An operation's access class. */
export const accessOf = (name: ToolName): Access => access[name];

export const toolNames = Record.keys(access);
