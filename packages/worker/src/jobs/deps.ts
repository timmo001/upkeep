/**
 * The deps job: read each repository's dependency updater config, find its
 * dependencies and the releases its policy allows, and log the groups of
 * updates the updater would open, with who owns each: the updater when it
 * automerges the group, otherwise Upkeep. In the repositories set to apply,
 * Upkeep's groups are applied, checked and pushed one at a time, as a dry
 * run unless that's turned off (#5).
 */
import { Api, Gh, GhCommandError } from "@timmo001/effect-gh";
import { Catalogue } from "@upkeep/api";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import * as Applier from "../deps/Applier";
import { Datasources } from "../deps/Datasources";
import * as Managers from "../deps/Managers";
import * as Planner from "../deps/Planner";
import { type Dependency, DepsError, type Policy } from "../deps/Policy";
import { type ReadFile, Updaters } from "../deps/Updaters";
import { listed, pushed, summary, trackedFor } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { ConsumersFailed } from "../Worker";
import * as Bump from "./bump";
import * as Drift from "./drift";

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

/** The commit subject for a group, as Renovate titles its pull request. */
const subject = (group: Planner.Group) => {
  const names = new Set(
    group.updates.map((update) => update.dependency.depName),
  );

  const [first] = group.updates;

  if (names.size !== 1 || first === undefined) return `Update ${group.name}`;

  return first.updateType === "digest"
    ? `Update ${first.dependency.depName} digest to ${first.to}`
    : `Update ${first.dependency.depName} to ${first.to}`;
};

interface ApplyContext {
  /** Where clones live, which mise is told to trust. */
  readonly root: string;
  readonly checks: ReadonlyArray<string> | undefined;
  readonly dryRun: boolean;
}

/**
 * Apply one group in a clean checkout, refresh its lockfiles, run the
 * repository's checks, then push the checked commit and watch its CI.
 */
const applyGroup = Effect.fnUntraced(function* (
  repo: string,
  branch: string,
  group: Planner.Group,
  context: ApplyContext,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(context.root, repo);
  const options = { cwd: directory, trusted: context.root };

  yield* Bump.checkout(repo, branch, directory, context.root);

  const files = new Set(group.updates.map((update) => update.dependency.file));

  for (const file of files) {
    const target = path.join(directory, file);
    let text = yield* fs.readFileString(target);

    for (const update of group.updates) {
      if (update.dependency.file !== file) continue;

      const edit = Applier.apply(update, text);

      if (Applier.Edit.$is("Unsupported")(edit))
        return yield* new DepsError({
          message: `${update.dependency.depName} in ${file}: ${edit.reason}`,
        });

      text = edit.text;
    }

    yield* fs.writeFileString(target, text);
  }

  const edited = (yield* Bump.run("git", ["diff", "--name-only"], options))
    .split("\n")
    .filter((file) => file !== "");

  if (edited.length === 0) {
    yield* RunLog.info(`${repo}: renovate/${group.branch} is already applied`);

    return false;
  }

  const mise = yield* Bump.usesMise(directory);

  yield* Bump.install(
    directory,
    edited.filter((file) => path.basename(file) === "package.json"),
    { trusted: context.root, mise },
  );

  if (
    edited.some((file) => /(?:^|\/)\.?mise\.toml$/.test(file)) &&
    (yield* fs.exists(path.join(directory, "mise.lock")))
  )
    yield* Bump.run("mise", ["lock"], options);

  const changed = (yield* Bump.run("git", ["diff", "--name-only"], options))
    .split("\n")
    .filter((file) => file !== "");

  // Workflows alone are checked by CI once they're pushed
  if (changed.some((file) => !file.startsWith(".github/"))) {
    const ran = yield* Bump.check(context.checks, { ...options, mise });

    yield* ran.length === 0
      ? RunLog.warn(
          `${repo}: has no check or build task, so nothing ran before the push`,
        )
      : RunLog.info(`${repo}: ${ran.join(", ")} passed`);
  }

  const message = subject(group);

  if (context.dryRun) {
    yield* RunLog.info(
      `${repo}: would push "${message}" (${changed.join(", ")})`,
    );

    return true;
  }

  yield* Bump.run("git", ["add", "--", ...changed], options);

  const sha = yield* Bump.commitAndPush(message, branch, options);

  yield* pushed(repo, sha, message);

  yield* RunLog.info(
    `${repo}: pushed ${sha.slice(0, 7)} "${message}", watching CI`,
  );

  const runs = yield* Bump.watch(repo, sha);

  yield* RunLog.info(
    runs === 0
      ? `${repo}: no CI ran on ${sha.slice(0, 7)}`
      : `${repo}: CI passed`,
  );

  yield* closeRenovate(repo, group, sha);

  return true;
});

const PullRequests = Schema.Array(Schema.Struct({ number: Schema.Number }));

/** Close the updater's open pull request for a group Upkeep landed. */
const closeRenovate = Effect.fnUntraced(function* (
  repo: string,
  group: Planner.Group,
  sha: string,
) {
  const owner = repo.slice(0, repo.indexOf("/"));

  const open = yield* Api.json(
    {
      endpoint: `repos/${repo}/pulls`,
      method: "GET",
      query: { state: "open", head: `${owner}:renovate/${group.branch}` },
    },
    PullRequests,
  );

  for (const pr of open) {
    yield* Api.empty({
      endpoint: `repos/${repo}/issues/${pr.number}/comments`,
      method: "POST",
      body: {
        body: `Upkeep landed this update in https://github.com/${repo}/commit/${sha}.`,
      },
    });

    yield* Api.empty({
      endpoint: `repos/${repo}/pulls/${pr.number}`,
      method: "PATCH",
      body: { state: "closed" },
    });

    yield* RunLog.info(
      `${repo}#${pr.number}: closed, landed in ${sha.slice(0, 7)}`,
    );
  }
});

/**
 * Apply each group Upkeep owns, in order. A group that fails is logged and
 * left, and the rest still go. Returns how many applied and which failed.
 */
const applyRepository = Effect.fnUntraced(function* (
  repo: string,
  branch: string,
  groups: ReadonlyArray<Planner.Group>,
  context: ApplyContext,
) {
  let applied = 0;
  const failed: Array<string> = [];

  for (const group of groups) {
    if (group.owner !== "upkeep") continue;

    yield* applyGroup(repo, branch, group, context).pipe(
      Effect.tap((done) =>
        Effect.sync(() => {
          if (done) applied += 1;
        }),
      ),
      Effect.catchCause((cause) =>
        RunLog.warn(
          `${repo}: renovate/${group.branch}: ${Bump.reason(cause)}`,
        ).pipe(Effect.andThen(Effect.sync(() => failed.push(group.branch)))),
      ),
    );
  }

  // A tool bump and its tooling.yml review go out together
  if (applied > 0 && !context.dryRun) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const tooling = path.join(context.root, repo, Drift.toolingFile);

    if (yield* fs.exists(tooling)) {
      yield* RunLog.info(`${repo}: checking tool drift after the updates`);

      yield* Drift.driftRepository(repo, {
        root: yield* Drift.cacheRoot,
        dryRun: false,
      }).pipe(
        Effect.catchCause((cause) =>
          RunLog.warn(`${repo}: drift: ${Bump.reason(cause)}`).pipe(
            Effect.andThen(Effect.sync(() => failed.push("drift"))),
          ),
        ),
      );
    }
  }

  return { applied, failed };
});

/** Plan every tracked repository with an updater config, two at a time. */
export const deps = Effect.fnUntraced(function* () {
  const settings = yield* Settings.load();
  const extras = settings.deps;
  const tracked = yield* trackedFor(Catalogue.deps.id);
  const path = yield* Path.Path;

  const applying = new Set(
    (extras?.apply ?? []).map((repo) => repo.toLowerCase()),
  );

  const dryRun = extras?.dryRun !== false;
  const root = path.join(path.dirname(yield* Bump.cacheRoot), "deps");

  const repos = (yield* repositories()).filter((repo) =>
    tracked(repo.full_name),
  );

  yield* RunLog.info(`Reading dependencies in ${repos.length} repositories`);

  if (applying.size > 0)
    yield* RunLog.info(
      `${dryRun ? "Dry run: applying" : "Applying"} updates in ${[...applying].toSorted().join(", ")}`,
    );

  const failed: Array<string> = [];
  let planned = 0;
  let groups = 0;
  let applied = 0;

  yield* Effect.forEach(
    repos,
    (repo) =>
      Effect.gen(function* () {
        const result = yield* planRepository(
          repo.full_name,
          repo.default_branch,
          extras,
        );

        if (Option.isNone(result)) return;

        planned += 1;
        groups += result.value.length;

        if (!applying.has(repo.full_name.toLowerCase())) return;

        const outcome = yield* applyRepository(
          repo.full_name,
          repo.default_branch,
          result.value,
          {
            root,
            checks: settings.bump?.repos?.[repo.full_name]?.checks,
            dryRun,
          },
        );

        applied += outcome.applied;

        if (outcome.failed.length > 0) failed.push(repo.full_name);
      }).pipe(
        Effect.catchCause((cause) =>
          RunLog.warn(`${repo.full_name}: ${Bump.reason(cause)}`).pipe(
            Effect.andThen(Effect.sync(() => failed.push(repo.full_name))),
          ),
        ),
      ),
    { concurrency: 2, discard: true },
  ).pipe(Effect.provide([Datasources.layer, Updaters.layer]));

  yield* summary(
    [
      `Planned updates for ${planned} repositories, ${groups} groups,`,
      ...(applying.size > 0
        ? [`${dryRun ? "would apply" : "applied"} ${applied},`]
        : []),
      `${listed(failed.toSorted())} failed`,
    ].join(" "),
  );

  if (failed.length > 0)
    return yield* new ConsumersFailed({
      action: "update the dependencies of",
      repos: failed.toSorted(),
    });
});
