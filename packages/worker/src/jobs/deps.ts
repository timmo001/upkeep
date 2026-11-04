/**
 * The deps job: read each repository's dependency updater config, find its
 * dependencies and the releases its policy allows, and log the groups of
 * updates the updater would open, with who owns each: the updater when it
 * automerges the group, otherwise Upkeep. It changes nothing yet; this is
 * the read-only first stage of Upkeep's own dependency updater (#5).
 */
import { Api, Gh, GhCommandError } from "@timmo001/effect-gh";
import { Catalogue } from "@upkeep/api";
import { Effect, Option, Schema } from "effect";
import { Datasources } from "../deps/Datasources";
import * as Managers from "../deps/Managers";
import * as Planner from "../deps/Planner";
import { type Dependency, DepsError, type Policy } from "../deps/Policy";
import { type ReadFile, Updaters } from "../deps/Updaters";
import { listed, summary, trackedFor } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { ConsumersFailed } from "../Worker";
import { reason } from "./bump";

const User = Schema.Struct({ login: Schema.String });

const OwnedRepository = Schema.Struct({
  full_name: Schema.String,
  archived: Schema.Boolean,
  fork: Schema.Boolean,
  default_branch: Schema.String,
  owner: Schema.Struct({ login: Schema.String }),
});

const Tree = Schema.Struct({
  truncated: Schema.Boolean,
  tree: Schema.Array(
    Schema.Struct({ path: Schema.String, type: Schema.String }),
  ),
});

const missing = (cause: unknown) =>
  cause instanceof GhCommandError && /\b404\b|Not Found/.test(cause.stderr);

/** What went wrong in a GitHub call, in one line. */
const ghMessage = (cause: unknown) =>
  cause instanceof GhCommandError
    ? (cause.stderr.trim().split("\n")[0] ?? `gh exited ${cause.exitCode}`)
    : cause instanceof Error
      ? cause.message
      : String(cause);

/** Read a file through the GitHub API, none when it isn't there. */
const readFile = (repo: string, path: string, ref?: string) =>
  Api.text({
    endpoint: `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
    method: "GET",
    headers: { Accept: "application/vnd.github.raw+json" },
    query: ref === undefined ? {} : { ref },
  }).pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      missing(cause)
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(
            new DepsError({
              message: `couldn't read ${repo}/${path}: ${ghMessage(cause)}`,
            }),
          ),
    ),
  );

/** The account's own repositories that aren't archived or forks. */
const repositories = Effect.fnUntraced(function* () {
  const { login } = yield* Api.json({ endpoint: "user", method: "GET" }, User);

  const pages = yield* Api.pages(
    {
      endpoint: "user/repos",
      method: "GET",
      query: { affiliation: "owner", per_page: 100 },
    },
    Schema.Array(OwnedRepository),
  );

  return pages
    .flat()
    .filter(
      (repo) =>
        !repo.archived &&
        !repo.fork &&
        repo.owner.login.toLowerCase() === login.toLowerCase(),
    )
    .toSorted((a, b) => a.full_name.localeCompare(b.full_name));
});

/** A dependency's identity in the log, such as `effect` or `aqua:jdx/hk`. */
const describe = (update: Planner.Update) =>
  `${update.dependency.depName} ${update.from} → ${update.to} (${update.updateType}${update.lockfile ? ", lockfile" : ""})`;

/** Plan one repository and log its groups. */
const planRepository = Effect.fnUntraced(function* (
  repo: string,
  branch: string,
  extras: Settings.Settings["deps"],
) {
  const updaters = yield* Updaters;
  const datasources = yield* Datasources;
  const gh = yield* Gh;

  const read: ReadFile = (repo, path, ref) =>
    readFile(repo, path, ref).pipe(Effect.provideService(Gh, gh));

  const tree = yield* Api.json(
    {
      endpoint: `repos/${repo}/git/trees/${encodeURIComponent(branch)}`,
      method: "GET",
      query: { recursive: 1 },
    },
    Tree,
  );

  const paths = tree.tree
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path);

  const detected = updaters.detect(paths);

  if (Option.isNone(detected)) return Option.none();

  const updaterPolicy = yield* updaters.read(repo, detected.value, read);

  const policy: Policy = {
    ...updaterPolicy,
    rules: [...updaterPolicy.rules, ...(extras?.rules ?? [])],
  };

  const files = new Map<string, string>();

  yield* Effect.forEach(
    Managers.wanted(policy, paths),
    (path) =>
      readFile(repo, path, branch).pipe(
        Effect.tap((text) =>
          Effect.sync(() => {
            if (Option.isSome(text)) files.set(path, text.value);
          }),
        ),
      ),
    { concurrency: 8, discard: true },
  );

  const extraction = Managers.extract(policy, files);

  const notes = [
    ...(tree.truncated
      ? ["the file tree was truncated, so some files weren't read"]
      : []),
    ...policy.notes,
    ...extraction.notes,
  ];

  const now = Date.now();
  const updates: Array<Planner.Update> = [];
  // Dependencies left out, by why
  const unread = new Map<string, Set<string>>();

  const leaveOut = (why: string, dependency: Dependency) =>
    unread.set(why, (unread.get(why) ?? new Set()).add(dependency.depName));

  yield* Effect.forEach(
    extraction.dependencies,
    (dependency) =>
      dependency.datasource === "local"
        ? Effect.void
        : datasources.lookup(dependency).pipe(
            Effect.map((releases) => {
              updates.push(
                ...Planner.updatesFor(policy, dependency, releases, now, repo)
                  .updates,
              );
            }),
            Effect.catch((error) =>
              Effect.sync(() => leaveOut(error.message, dependency)),
            ),
          ),
    { concurrency: 8, discard: true },
  );

  const groups = Planner.group(policy, updates);

  yield* RunLog.info(
    `${repo}: ${detected.value.adapter.name} (${detected.value.file}), ${extraction.dependencies.length} dependencies in ${files.size} files, ${groups.length} ${groups.length === 1 ? "group" : "groups"}`,
  );

  for (const group of groups) {
    const lines = [...new Set(group.updates.map(describe))];

    yield* RunLog.info(
      `${repo}: renovate/${group.branch} "${group.name}", owner ${group.owner}\n${lines.map((line) => `  ${line}`).join("\n")}`,
    );
  }

  for (const note of notes) yield* RunLog.info(`${repo}: note: ${note}`);

  for (const [why, names] of unread)
    yield* RunLog.warn(
      `${repo}: left out, ${why}: ${[...names].toSorted().join(", ")}`,
    );

  return Option.some(groups);
});

/** Plan every tracked repository with an updater config, two at a time. */
export const deps = Effect.fnUntraced(function* () {
  const settings = yield* Settings.load();
  const extras = settings.deps;
  const tracked = yield* trackedFor(Catalogue.deps.id);

  const repos = (yield* repositories()).filter((repo) =>
    tracked(repo.full_name),
  );

  yield* RunLog.info(`Reading dependencies in ${repos.length} repositories`);

  const failed: Array<string> = [];
  let planned = 0;
  let groups = 0;

  yield* Effect.forEach(
    repos,
    (repo) =>
      planRepository(repo.full_name, repo.default_branch, extras).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (Option.isSome(result)) {
              planned += 1;
              groups += result.value.length;
            }
          }),
        ),
        Effect.catchCause((cause) =>
          RunLog.warn(`${repo.full_name}: ${reason(cause)}`).pipe(
            Effect.andThen(Effect.sync(() => failed.push(repo.full_name))),
          ),
        ),
      ),
    { concurrency: 2, discard: true },
  ).pipe(Effect.provide([Datasources.layer, Updaters.layer]));

  yield* summary(
    `Planned updates for ${planned} repositories, ${groups} groups, ${listed(failed.toSorted())} failed`,
  );

  if (failed.length > 0)
    return yield* new ConsumersFailed({
      action: "read the dependencies of",
      repos: failed.toSorted(),
    });
});
