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
  runs: "read",
  log: "read",
  run: "write",
  cancel: "write",
} satisfies { readonly [Name in ToolName]: Access };

/** An operation's access class. */
export const accessOf = (name: ToolName): Access => access[name];

export const toolNames = Record.keys(access);
