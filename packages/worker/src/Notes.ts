/**
 * The standing notes an agent reads before working on a repository or on
 * Upkeep, and the lines in what it says last that keep a new note or flag one
 * as out of date. Agents write them as lines rather than through a tool, so
 * they need nothing but the worker to reach the server.
 */
import type { Domain } from "@upkeep/api";
import { Effect } from "effect";
import { reason } from "./Failure";
import { Reporter } from "./Reporter";
import * as RunLog from "./RunLog";

const sameScope = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// `Note for owner/name: text`, the scope maybe in backticks, maybe as a list item
const added = /^\s*(?:[-*]\s+)?Note for\s+`?([^\s:`]+)`?\s*:\s*(.+)$/i;

// `Note out of date: <id>: why`, the id maybe in brackets or backticks
const flagged =
  /^\s*(?:[-*]\s+)?Note out of date:\s*[[`]?([A-Za-z0-9]+)[\]`]?\s*:\s*(.+)$/i;

const shown = (note: Domain.Note) =>
  [
    `- [${note.id}] ${note.scope}: ${note.text.replaceAll("\n", "\n  ")}`,
    ...(note.stale === null
      ? []
      : [`  (flagged as maybe out of date: ${note.stale.reason})`]),
  ].join("\n");

/**
 * What the agent is told of the notes: those kept for `scopes`, and how to
 * keep a new one or flag one as out of date. A server that can't send them
 * leaves only the how.
 */
export const prompt = Effect.fnUntraced(function* (
  scopes: ReadonlyArray<string>,
) {
  const notes = (yield* (yield* Reporter)
    .notes()
    .pipe(
      Effect.catchCause((cause) =>
        RunLog.warn(`Couldn't read the notes: ${reason(cause)}`).pipe(
          Effect.as([]),
        ),
      ),
    )).filter((note) => scopes.some((scope) => sameScope(scope, note.scope)));

  const named = scopes.map((scope) => `\`${scope}\``).join(" or ");

  return [
    ...(notes.length === 0
      ? []
      : [
          "Notes kept for this work by the person and earlier agents. Follow them unless they plainly no longer hold:",
          "",
          ...notes.map(shown),
          "",
        ]),
    `When you learn something the next agent here would need that the repository's own docs don't say, such as a check that needs something running first, keep it as a note: a line of \`Note for <scope>: <the note>\` in your summary, before the Outcome line, where the scope is ${named}. Keep notes short and lasting, not a record of this run. When a note above no longer holds, say so with a line of \`Note out of date: <its id>: <why>\`, and the person decides whether to drop it.`,
  ].join("\n");
});

/**
 * Keep the notes the agent wrote in what it said last, and flag those it
 * said are out of date. A note for a scope it wasn't working on is skipped,
 * and one that can't be sent is logged rather than failing the run.
 */
export const record = Effect.fnUntraced(function* (
  said: string | null,
  scopes: ReadonlyArray<string>,
) {
  const reporter = yield* Reporter;

  for (const line of (said ?? "").split("\n")) {
    const note = added.exec(line);
    const stale = flagged.exec(line);

    if (note !== null) {
      const [, written = "", text = ""] = note;
      const scope = scopes.find((candidate) => sameScope(candidate, written));

      if (scope === undefined) {
        yield* RunLog.warn(
          `Skipped a note for ${written}, which this run didn't work on`,
        );
        continue;
      }

      yield* reporter.addNote(scope, text.trim()).pipe(
        Effect.andThen(RunLog.info(`Kept a note for ${scope}: ${text.trim()}`)),
        Effect.catchCause((cause) =>
          RunLog.warn(`Couldn't keep a note for ${scope}: ${reason(cause)}`),
        ),
      );
    }

    if (stale !== null) {
      const [, id = "", why = ""] = stale;

      yield* reporter.staleNote(id, why.trim()).pipe(
        Effect.andThen(
          RunLog.info(`Flagged note ${id} as out of date: ${why.trim()}`),
        ),
        Effect.catchCause((cause) =>
          RunLog.warn(`Couldn't flag note ${id}: ${reason(cause)}`),
        ),
      );
    }
  }
});
