/**
 * The label job: bring each repository's labels in line with the manifest
 * groundwork's conventions print. Renames go through a label's aliases so
 * issues and pull requests keep their labels, and a label the manifest
 * doesn't know is deleted only when nothing uses it.
 */
import { Graphql, Label } from "@timmo001/effect-gh";
import { Catalogue } from "@upkeep/api";
import { Config, Data, Effect, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { pretty } from "../Failure";
import { listed, summary, trackedFor } from "../Reporter";
import * as RunLog from "../RunLog";

type Current = Label.Label;

/** A label the manifest wants, with the older names it renames from. */
export const Wanted = Schema.Struct({
  name: Schema.String,
  color: Schema.String,
  description: Schema.String,
  aliases: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type Wanted = typeof Wanted.Type;

/** One repository's entry, as `conventions labels --all` prints it. */
const Entry = Schema.Struct({
  repo: Schema.String,
  labels: Schema.Array(Wanted),
  keep: Schema.Array(Schema.String),
});

export type Change = Data.TaggedEnum<{
  Create: { readonly label: Current };
  Update: { readonly from: string; readonly label: Current };
  Unknown: { readonly name: string };
}>;

export const Change = Data.taggedEnum<Change>();

/** A name as the plan compares it: ignoring case, and `-` or `_` for spaces. */
const key = (name: string) => name.toLowerCase().replaceAll(/[-_]/g, " ");

const matches = (current: Current, wanted: Current) =>
  current.name === wanted.name &&
  key(current.color) === key(wanted.color) &&
  current.description === wanted.description;

const toLabel = (wanted: Wanted): Current => ({
  name: wanted.name,
  color: wanted.color,
  description: wanted.description,
});

/**
 * The changes that bring `current` in line with `wanted`. A label is found by
 * its name first, then by an alias, ignoring case and `-` or `_` for spaces,
 * and is updated in place either way, which fixes its name, color and
 * description at once. Labels nothing claims are returned as unknown, unless
 * `keep` lists them.
 */
export const plan = (
  wanted: ReadonlyArray<Wanted>,
  current: ReadonlyArray<Current>,
  keep: ReadonlyArray<string> = [],
): ReadonlyArray<Change> => {
  const byKey = new Map(current.map((label) => [key(label.name), label]));
  const claimed = new Set(keep.map(key));
  const changes: Array<Change> = [];

  const claim = (name: string) => {
    const label = byKey.get(key(name));

    if (label === undefined || claimed.has(key(name))) return undefined;

    claimed.add(key(name));

    return label;
  };

  for (const label of wanted) {
    const found =
      claim(label.name) ??
      (label.aliases ?? []).map(claim).find((item) => item !== undefined);

    if (found === undefined) {
      changes.push(Change.Create({ label: toLabel(label) }));

      continue;
    }

    if (!matches(found, label)) {
      changes.push(Change.Update({ from: found.name, label: toLabel(label) }));
    }
  }

  for (const label of current) {
    if (!claimed.has(key(label.name))) {
      changes.push(Change.Unknown({ name: label.name }));
    }
  }

  return changes;
};

/**
 * Every repository's wanted labels, from the groundwork checkout. It runs
 * through mise, so it gets groundwork's pinned Bun even when the worker's
 * `PATH` has no mise shims, as a service started before the session's is.
 */
const manifest = Effect.fnUntraced(function* () {
  const groundwork = yield* Config.String("UPKEEP_GROUNDWORK");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const output = yield* spawner.string(
    ChildProcess.make(
      "mise",
      ["exec", "--", "bun", "run", "src/cli.ts", "labels", "--all"],
      {
        cwd: `${groundwork}/packages/conventions`,
        stdin: "ignore",
        extendEnv: true,
        env: { MISE_YES: "1" },
      },
    ),
  );

  return yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Array(Entry)),
  )(output);
});

const usageDocument = `
  query ($owner: String!, $name: String!, $label: String!) {
    repository(owner: $owner, name: $name) {
      label(name: $label) {
        issues { totalCount }
        pullRequests { totalCount }
      }
    }
  }
`;

const Usage = Schema.Struct({
  repository: Schema.Struct({
    label: Schema.NullOr(
      Schema.Struct({
        issues: Schema.Struct({ totalCount: Schema.Number }),
        pullRequests: Schema.Struct({ totalCount: Schema.Number }),
      }),
    ),
  }),
});

/** How many issues and pull requests carry a label. */
const usage = Effect.fnUntraced(function* (repo: string, label: string) {
  const [owner = "", name = ""] = repo.split("/");

  const result = yield* Graphql.query(
    usageDocument,
    { owner, name, label },
    Usage,
  );

  const found = result.repository.label;

  return found === null
    ? 0
    : found.issues.totalCount + found.pullRequests.totalCount;
});

/**
 * Apply one change. An unknown label is deleted when nothing uses it, and
 * otherwise left and listed in the run's log.
 */
const apply = (repo: string, change: Change) =>
  Change.$match(change, {
    Create: ({ label }) =>
      Label.create({
        repo,
        name: label.name,
        color: label.color,
        description: label.description,
      }).pipe(Effect.andThen(RunLog.info(`${repo}: created ${label.name}`))),
    Update: ({ from, label }) =>
      Label.edit({
        repo,
        name: from,
        newName: label.name,
        color: label.color,
        description: label.description,
      }).pipe(
        Effect.andThen(
          RunLog.info(
            from === label.name
              ? `${repo}: updated ${label.name}`
              : `${repo}: renamed ${from} to ${label.name}`,
          ),
        ),
      ),
    Unknown: ({ name }) =>
      Effect.gen(function* () {
        const used = yield* usage(repo, name);

        if (used > 0) {
          return yield* RunLog.warn(
            `${repo}: left ${name}, which the manifest doesn't know, on ${used} issues and pull requests`,
          );
        }

        yield* Label.remove({ repo, name });
        yield* RunLog.info(`${repo}: deleted unused ${name}`);
      }),
  });

/** Bring one repository's labels in line with its entry. */
const sync = Effect.fnUntraced(function* (entry: typeof Entry.Type) {
  const current = yield* Label.list({ repo: entry.repo });
  const changes = plan(entry.labels, current, entry.keep);

  for (const change of changes) yield* apply(entry.repo, change);

  if (changes.length === 0) yield* RunLog.info(`${entry.repo}: up to date`);

  return changes.length;
});

class LabelsFailed extends Schema.TaggedError<LabelsFailed>()("LabelsFailed", {
  repos: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Couldn't sync the labels of ${this.repos.join(", ")}`;
  }
}

/**
 * Sync every tracked repository in the manifest. One that fails is logged and
 * the rest carry on; the run fails at the end, naming them.
 */
export const labels = Effect.fnUntraced(function* () {
  const tracked = yield* trackedFor(Catalogue.labels.id);
  const entries = (yield* manifest()).filter((entry) => tracked(entry.repo));
  const failed: Array<string> = [];

  const changed: Array<string> = [];

  yield* RunLog.info(`Syncing the labels of ${entries.length} repositories`);

  for (const entry of entries) {
    yield* sync(entry).pipe(
      Effect.tap((count) =>
        Effect.sync(() => {
          if (count > 0) changed.push(entry.repo);
        }),
      ),
      Effect.catchCause((cause) =>
        RunLog.warn(`${entry.repo}: ${pretty(cause)}`).pipe(
          Effect.andThen(Effect.sync(() => failed.push(entry.repo))),
        ),
      ),
    );
  }

  yield* summary(
    `Changed labels in ${listed(changed)}, ${entries.length - changed.length - failed.length} already in line, ${listed(failed)} failed`,
  );

  if (failed.length > 0) return yield* new LabelsFailed({ repos: failed });
});
