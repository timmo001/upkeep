/**
 * Your own list of repositories, from the `names` setting's command: the name
 * each is shown by, which an agent opened for it takes for its workspace,
 * and, where the list says, the path of its checkout, which the agent starts
 * in.
 */
import { homedir } from "node:os";
import { Effect, Schema } from "effect";
import { reason } from "./Failure";
import * as RunLog from "./RunLog";
import * as Settings from "./settings";
import { run } from "./jobs/bump";

/** What a `names` command prints: repositories by `owner/name`, with a name. */
const Named = Schema.Array(
  Schema.Struct({
    github: Schema.optionalKey(Schema.NullOr(Schema.String)),
    name: Schema.String,
    path: Schema.optionalKey(Schema.String),
  }),
);

/** The list the `names` command prints. None without the setting, or when it fails. */
export const listed = Effect.gen(function* () {
  const command = (yield* Settings.load()).names?.command ?? [];
  const [program, ...args] = command;

  if (program === undefined) return [];

  return yield* run(program, args, { cwd: homedir(), trusted: homedir() }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Named))),
    Effect.catchCause((cause) =>
      RunLog.warn(
        `Couldn't read names from ${command.join(" ")}: ${reason(cause)}`,
      ).pipe(Effect.as([])),
    ),
  );
});

/** A repository's entry in your list, by `owner/name` ignoring case, or undefined. */
export const find = Effect.fnUntraced(function* (repo: string) {
  const wanted = repo.toLowerCase();

  return (yield* listed).find(
    (entry) => entry.github?.toLowerCase() === wanted,
  );
});

/** The name an agent's workspace gets: your list's, else the repository's own. */
export const nameOf = (
  repo: string,
  entry: { readonly name: string } | undefined,
) => entry?.name.trim() || (repo.split("/").at(-1) ?? repo);
