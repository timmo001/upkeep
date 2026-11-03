/**
 * Every operation the CLI offers, described once with how an agent may use
 * it. The Code Mode manifest and the MCP server both read this list, following
 * Groundwork's behavior conventions: https://groundwork.timmo.dev/behavior
 */
import { Schema } from "effect";

export const Access = Schema.Literals(["read", "write", "ask", "power"]);

export type Access = typeof Access.Type;

export interface Operation {
  readonly name: string;
  readonly description: string;
  readonly access: Access;
}

export const operations: readonly Operation[] = [
  {
    name: "status",
    description: "List the jobs upkeep runs",
    access: "read",
  },
  {
    name: "runs",
    description: "List runs on the server, newest first",
    access: "read",
  },
  {
    name: "log",
    description: "Print a run's log",
    access: "read",
  },
  {
    name: "run",
    description: "Queue a run of a job on the server",
    access: "write",
  },
];
