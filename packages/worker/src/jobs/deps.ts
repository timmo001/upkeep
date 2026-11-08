/**
 * The deps job: check out each repository and read its dependency updater
 * config, find its dependencies and the releases its policy allows, and log
 * the groups of updates the updater would open, with who owns each: the
 * updater when it automerges the group, otherwise Upkeep. In the repositories
 * set to apply, Upkeep's groups are applied, checked and pushed one at a time,
 * then its lock file maintenance when it's due, as a dry run unless that's
 * turned off (#5).
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
import { ghReason, reason } from "../Failure";
import * as GitHubApp from "../GitHubApp";
import { listed, pushed, summary, trackedFor } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { ConsumersFailed } from "../Worker";
import * as Bump from "./bump";
import * as Drift from "./drift";

const OwnedRepository = Schema.Struct({
  full_name: Schema.String,
  archived: Schema.Boolean,
  fork: Schema.Boolean,
  default_branch: Schema.String,
  owner: Schema.Struct({ login: Schema.String }),
});

const missing = (cause: unknown) =>
  cause instanceof GhCommandError && /\b404\b|Not Found/.test(cause.stderr);

/** What went wrong in a GitHub call, in one line. */
const ghMessage = (cause: unknown) =>
  cause instanceof GhCommandError
    ? ghReason(cause)
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
  const login = yield* GitHubApp.login;

  // An installation token can't list `user/repos`, only the repositories the
  // App is installed on
  const pages = yield* Option.match(yield* GitHubApp.Account, {
    onNone: () =>
      Api.pages(
        {
          endpoint: "user/repos",
          method: "GET",
          query: { affiliation: "owner", per_page: 100 },
        },
        Schema.Array(OwnedRepository),
      ),
    onSome: () =>
      Api.pages(
        {
          endpoint: "installation/repositories",
          method: "GET",
          query: { per_page: 100 },
        },
        Schema.Struct({ repositories: Schema.Array(OwnedRepository) }),
      ).pipe(
        Effect.map((pages) => pages.map(({ repositories }) => repositories)),
      ),
  });

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
  update.updateType === "replacement"
    ? `${update.dependency.depName} ${update.from} → ${update.newName ?? update.dependency.depName} ${update.to} (replacement)`
    : `${update.dependency.depName} ${update.from} → ${update.to} (${update.updateType}${update.lockfile ? ", lockfile" : ""})`;

/** Renovate's branch topic and commit message for lock file maintenance. */
const maintenanceBranch = "lock-file-maintenance";
const maintenanceSubject = "Lock file maintenance";

/** Lock file maintenance's owner, as for a group: the updater when it automerges. */
const maintenanceOwner = (policy: Policy) =>
  policy.updaterRuns && policy.maintenance?.automerge === true
    ? policy.updater
    : "upkeep";

/**
 * Plan one repository and log its groups, reading its files from a clean
 * checkout, since a git fetch doesn't count against the API's rate limit.
 */
const planRepository = Effect.fnUntraced(function* (
  repo: string,
  branch: string,
  extras: Settings.Settings["deps"],
  root: string,
) {
  const updaters = yield* Updaters;
  const datasources = yield* Datasources;
  const gh = yield* Gh;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const directory = path.join(root, repo);
  const options = { cwd: directory, trusted: root };

  yield* Bump.checkout(repo, branch, directory, root);

  const paths = (yield* Bump.run("git", ["ls-files", "-z"], options))
    .split("\0")
    .filter((file) => file !== "");

  const readLocal = (file: string) =>
    Effect.gen(function* () {
      const target = path.join(directory, file);

      return (yield* fs.exists(target))
        ? Option.some(yield* fs.readFileString(target))
        : Option.none<string>();
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DepsError({
            message: `couldn't read ${repo}/${file}: ${cause.message}`,
          }),
      ),
    );

  // Presets from other repositories, or at a tag, still come from the API
  const read: ReadFile = (from, file, ref) =>
    from === repo && ref === undefined
      ? readLocal(file)
      : readFile(from, file, ref).pipe(Effect.provideService(Gh, gh));

  const detected = updaters.detect(paths);

  if (Option.isNone(detected)) return Option.none();

  const updaterPolicy = yield* updaters.read(repo, detected.value, read);

  const policy: Policy = {
    ...updaterPolicy,
    rules: [...updaterPolicy.rules, ...(extras?.rules ?? [])],
  };

  const files = new Map<string, string>();

  for (const file of Managers.wanted(policy, paths)) {
    const text = yield* readLocal(file);

    if (Option.isSome(text)) files.set(file, text.value);
  }

  // Submodule commits, which the tree records as gitlinks
  const gitlinks = new Map(
    (yield* Bump.run("git", ["ls-files", "--stage", "-z"], options))
      .split("\0")
      .flatMap((entry) => {
        const link = /^160000 (?<sha>[a-f\d]{40}) \d\t(?<file>.+)$/.exec(
          entry,
        )?.groups;

        return link?.sha === undefined || link.file === undefined
          ? []
          : [[link.file, link.sha] as const];
      }),
  );

  const extraction = yield* Managers.extract(policy, files, gitlinks);

  const notes = [...policy.notes, ...extraction.notes];

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
        : datasources.lookup(dependency, policy.customDatasources).pipe(
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

  if (policy.maintenance !== undefined)
    yield* RunLog.info(
      `${repo}: renovate/${maintenanceBranch} "${maintenanceSubject}", every ${policy.maintenance.everyDays} ${policy.maintenance.everyDays === 1 ? "day" : "days"}, owner ${maintenanceOwner(policy)}`,
    );

  for (const note of notes) yield* RunLog.info(`${repo}: note: ${note}`);

  for (const [why, names] of unread)
    yield* RunLog.warn(
      `${repo}: left out, ${why}: ${[...names].toSorted().join(", ")}`,
    );

  return Option.some({ groups, policy });
});

/** The commit subject for a group, as Renovate titles its pull request. */
const subject = (group: Planner.Group) => {
  const names = new Set(
    group.updates.map((update) => update.dependency.depName),
  );

  const [first] = group.updates;

  if (names.size !== 1 || first === undefined) return `Update ${group.name}`;

  if (first.updateType === "replacement")
    return `Replace ${first.dependency.depName} with ${first.newName ?? first.dependency.depName} ${first.to}`;

  return first.updateType === "digest"
    ? `Update ${first.dependency.depName} digest to ${first.to}`
    : `Update ${first.dependency.depName} to ${first.to}`;
};

interface ApplyContext {
  /** Where clones live, which mise is told to trust. */
  readonly root: string;
  readonly checks: ReadonlyArray<string> | undefined;
  readonly generate: ReadonlyArray<string> | undefined;
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

  // A submodule moves by checking out its new commit, not by an edit
  const submodules = group.updates.filter(
    (update) => update.dependency.manager === "git-submodules",
  );

  const textual = group.updates.filter(
    (update) => update.dependency.manager !== "git-submodules",
  );

  for (const update of submodules) {
    if (update.digest === undefined) {
      yield* RunLog.warn(
        `${repo}: renovate/${group.branch} left to the updater: ${update.dependency.depName}: no commit to move to`,
      );

      return false;
    }

    const submodule = {
      cwd: path.join(directory, update.dependency.depName),
      trusted: context.root,
    };

    yield* Bump.run(
      "git",
      ["fetch", "--quiet", "origin", update.digest],
      submodule,
    );
    yield* Bump.run(
      "git",
      ["checkout", "--quiet", "--detach", update.digest],
      submodule,
    );
  }

  const files = new Set(textual.map((update) => update.dependency.file));
  const edits = new Map<string, string>();

  for (const file of files) {
    let text = yield* fs.readFileString(path.join(directory, file));

    for (const update of textual) {
      if (update.dependency.file !== file) continue;

      const edit = Applier.apply(update, text);

      // Something Upkeep can't do yet isn't a fault to heal; the updater
      // still has the group
      if (Applier.Edit.$is("Unsupported")(edit)) {
        yield* RunLog.warn(
          `${repo}: renovate/${group.branch} left to the updater: ${update.dependency.depName} in ${file}: ${edit.reason}`,
        );

        return false;
      }

      text = edit.text;
    }

    edits.set(file, text);
  }

  for (const [file, text] of edits)
    yield* fs.writeFileString(path.join(directory, file), text);

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

  return yield* land(repo, branch, group.branch, subject(group), changed, {
    ...context,
    mise,
  });
});

/**
 * Rebuild the repository's generated files, check what a checkout changed,
 * then push it as one commit, watch its CI and close the updater's pull
 * request on `renovate/<topic>`. Returns true, as something was applied, or
 * would be in a dry run.
 */
const land = Effect.fnUntraced(function* (
  repo: string,
  branch: string,
  topic: string,
  message: string,
  edited: ReadonlyArray<string>,
  context: ApplyContext & { readonly mise: boolean },
) {
  const path = yield* Path.Path;
  const options = { cwd: path.join(context.root, repo), trusted: context.root };

  const changed = [
    ...new Set([
      ...edited,
      ...(yield* Bump.generate(repo, context.generate, options)),
    ]),
  ];

  // Workflows alone are checked by CI once they're pushed
  if (changed.some((file) => !file.startsWith(".github/"))) {
    const ran = yield* Bump.check(context.checks, {
      ...options,
      mise: context.mise,
    });

    yield* ran.length === 0
      ? RunLog.warn(
          `${repo}: has no check or build task, so nothing ran before the push`,
        )
      : RunLog.info(`${repo}: ${ran.join(", ")} passed`);
  }

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

  yield* closeRenovate(repo, topic, sha);

  return true;
});

const day = 24 * 60 * 60 * 1000;

/**
 * Lock file maintenance: when no maintenance commit, Renovate's or Upkeep's,
 * landed within its schedule's period, write each lockfile afresh, then check
 * and push them as one commit. Returns whether anything was applied.
 */
const maintainLockfiles = Effect.fnUntraced(function* (
  repo: string,
  branch: string,
  policy: Policy,
  everyDays: number,
  context: ApplyContext,
) {
  const path = yield* Path.Path;
  const directory = path.join(context.root, repo);
  const options = { cwd: directory, trusted: context.root };

  yield* Bump.checkout(repo, branch, directory, context.root);

  const last = (yield* Bump.run(
    "git",
    ["log", "-1", "--format=%ct", "-i", `--grep=${maintenanceSubject}`],
    options,
  )).trim();

  // A run every few hours shouldn't push it off by one
  const at = last === "" ? undefined : Number(last) * 1000;

  if (at !== undefined && Date.now() - at < everyDays * day - day / 4) {
    yield* RunLog.info(
      `${repo}: renovate/${maintenanceBranch} isn't due, last done ${new Date(at).toISOString().slice(0, 10)}`,
    );

    return false;
  }

  const lockfiles = (yield* Bump.run("git", ["ls-files", "-z"], options))
    .split("\0")
    .filter(
      (file) =>
        file !== "" &&
        Bump.regenerates(file) &&
        !Managers.ignored(policy, file),
    );

  if (lockfiles.length === 0) {
    yield* RunLog.info(
      `${repo}: renovate/${maintenanceBranch} has no lockfile to refresh`,
    );

    return false;
  }

  const mise = yield* Bump.usesMise(directory);

  for (const lockfile of lockfiles)
    yield* Bump.regenerate(directory, lockfile, {
      trusted: context.root,
      mise,
    });

  const changed = (yield* Bump.run("git", ["diff", "--name-only"], options))
    .split("\n")
    .filter((file) => file !== "");

  if (changed.length === 0) {
    yield* RunLog.info(
      `${repo}: renovate/${maintenanceBranch}: ${listed(lockfiles)} already current`,
    );

    return false;
  }

  return yield* land(
    repo,
    branch,
    maintenanceBranch,
    maintenanceSubject,
    changed,
    { ...context, mise },
  );
});

const PullRequests = Schema.Array(Schema.Struct({ number: Schema.Number }));

/** Close the updater's open pull request on a branch Upkeep landed. */
const closeRenovate = Effect.fnUntraced(function* (
  repo: string,
  topic: string,
  sha: string,
) {
  const owner = repo.slice(0, repo.indexOf("/"));

  const open = yield* Api.json(
    {
      endpoint: `repos/${repo}/pulls`,
      method: "GET",
      query: { state: "open", head: `${owner}:renovate/${topic}` },
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
 * Apply each group Upkeep owns, in order, then lock file maintenance when
 * it's due, so it starts from the updated manifests. A group that fails is
 * logged and left, and the rest still go. Returns how many applied and which
 * failed.
 */
const applyRepository = Effect.fnUntraced(function* (
  repo: string,
  branch: string,
  groups: ReadonlyArray<Planner.Group>,
  policy: Policy,
  context: ApplyContext,
) {
  let applied = 0;
  const failed: Array<string> = [];

  const count = (done: boolean) =>
    Effect.sync(() => {
      if (done) applied += 1;
    });

  for (const group of groups) {
    if (group.owner !== "upkeep") continue;

    yield* applyGroup(repo, branch, group, context).pipe(
      Effect.tap(count),
      Effect.catchCause((cause) =>
        RunLog.warn(`${repo}: renovate/${group.branch}: ${reason(cause)}`).pipe(
          Effect.andThen(Effect.sync(() => failed.push(group.branch))),
        ),
      ),
    );
  }

  if (policy.maintenance !== undefined && maintenanceOwner(policy) === "upkeep")
    yield* maintainLockfiles(
      repo,
      branch,
      policy,
      policy.maintenance.everyDays,
      context,
    ).pipe(
      Effect.tap(count),
      Effect.catchCause((cause) =>
        RunLog.warn(
          `${repo}: renovate/${maintenanceBranch}: ${reason(cause)}`,
        ).pipe(
          Effect.andThen(Effect.sync(() => failed.push(maintenanceBranch))),
        ),
      ),
    );

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
        // A release to review goes to the heal with the rest, as drift's
        // review in a deps run is part of landing the update
        Effect.tap((outcome) =>
          outcome === "review"
            ? Effect.sync(() => failed.push("drift"))
            : Effect.void,
        ),
        Effect.catchCause((cause) =>
          RunLog.warn(`${repo}: drift: ${reason(cause)}`).pipe(
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
          root,
        );

        if (Option.isNone(result)) return;

        planned += 1;
        groups += result.value.groups.length;

        if (!applying.has(repo.full_name.toLowerCase())) return;

        const outcome = yield* applyRepository(
          repo.full_name,
          repo.default_branch,
          result.value.groups,
          result.value.policy,
          {
            root,
            checks: settings.bump?.repos?.[repo.full_name]?.checks,
            generate: settings.bump?.repos?.[repo.full_name]?.generate,
            dryRun,
          },
        );

        applied += outcome.applied;

        if (outcome.failed.length > 0) failed.push(repo.full_name);
      }).pipe(
        Effect.catchCause((cause) =>
          RunLog.warn(`${repo.full_name}: ${reason(cause)}`).pipe(
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
