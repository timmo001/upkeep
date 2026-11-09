/**
 * Git worktrees for the work Upkeep does, in place of a clone of its own for
 * each job. Each comes from your checkout of the repository, at the `path`
 * your `names` list gives it, or else from one clone shared in Upkeep's
 * cache, and lives in Herdr's worktree folder as
 * `~/.herdr/worktrees/<checkout>/upkeep-<job>-<id>`, beside your own, so one
 * opened later is grouped with the repository. Each is detached at the tip of
 * the branch, which your checkout may have checked out itself.
 *
 * A run's worktrees go when it ends. An agent's are kept while it may still
 * need them, such as a heal left for you or a held skill change, and go once
 * it's done with them.
 */
import { Repository } from "@timmo001/effect-gh";
import {
  ByteSize,
  Clock,
  Config,
  Effect,
  FileSystem,
  Option,
  Path,
  Semaphore,
} from "effect";
import { run } from "./Command";
import { reason } from "./Failure";
import * as Names from "./Names";
import * as RunLog from "./RunLog";

/** Where the worktrees live, which is also the path mise trusts for them. */
export const root = Config.String("HOME").pipe(
  Config.map((home) => `${home}/.herdr/worktrees`),
);

/** Where the shared clones live, for repositories with no checkout here. */
const clones = Config.String("XDG_CACHE_HOME").pipe(
  Config.orElse(() =>
    Config.String("HOME").pipe(Config.map((home) => `${home}/.cache`)),
  ),
  Config.map((cache) => `${cache}/upkeep/repos`),
);

/**
 * Every worktree, or folder of them, Upkeep makes is named with this, and
 * only those are ever removed.
 */
const prefix = "upkeep-";

/** The worktrees an agent works in, kept for it when it stops for you. */
const agentPrefix = `${prefix}agent-`;

type Listed = ReadonlyArray<{
  readonly github?: string | null;
  readonly path?: string;
}>;

// One fetch or new worktree at a time in a repository, so two never fight
// over its refs or its clone
const locks = new Map<string, Semaphore.Semaphore>();

const lockOf = (repo: string) => {
  const key = repo.toLowerCase();
  const found = locks.get(key);

  if (found !== undefined) return found;

  const lock = Semaphore.makeUnsafe(1);
  locks.set(key, lock);

  return lock;
};

/** A short id for a run's or an agent's worktrees. */
export const newId = () => crypto.randomUUID().slice(0, 8);

/** Whether a checkout's origin is the repository on GitHub. */
const cloneOf = (directory: string, repo: string) =>
  run("git", ["remote", "get-url", "origin"], {
    cwd: directory,
    trusted: "",
  }).pipe(
    Effect.map((url) => {
      const plain = url
        .trim()
        .toLowerCase()
        .replace(/\/$/, "")
        .replace(/\.git$/, "");

      return (
        plain.endsWith(`github.com/${repo.toLowerCase()}`) ||
        plain.endsWith(`github.com:${repo.toLowerCase()}`)
      );
    }),
    Effect.orElseSucceed(() => false),
  );

/**
 * The repository a worktree comes from, and the folder its worktrees go in:
 * your checkout, when your list has one here cloned from the repository, or
 * else the shared clone, made the first time.
 */
const baseOf = Effect.fnUntraced(function* (repo: string, listed: Listed) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const wanted = repo.toLowerCase();
  const own = listed.find((entry) => entry.github?.toLowerCase() === wanted);

  if (
    own?.path !== undefined &&
    (yield* fs.exists(path.join(own.path, ".git"))) &&
    (yield* cloneOf(own.path, repo))
  )
    return { directory: own.path, folder: path.basename(own.path) };

  const directory = path.join(yield* clones, `${repo}.git`);

  if (!(yield* fs.exists(directory))) {
    yield* RunLog.info(`${repo}: cloning into ${directory}`);
    yield* fs.makeDirectory(path.dirname(directory), { recursive: true });
    yield* Repository.clone({
      repository: repo,
      directory,
      gitArgs: ["--quiet", "--bare", "--filter=blob:none"],
    });
  }

  return { directory, folder: repo.split("/").at(-1) ?? repo };
});

/**
 * Lock files an interrupted Git command leaves behind, which stop every
 * command after it in that repository: a worktree's own, and those shared
 * by every worktree of a repository, which a fetch takes.
 */
const ownLocks = new Set(["index.lock", "HEAD.lock"]);

const sharedLocks = new Set([
  "config.lock",
  "packed-refs.lock",
  "shallow.lock",
]);

/** How old a lock is before it's taken as left by a command that died. */
const staleLockMillis = 60 * 60 * 1000;

/**
 * Remove stale lock files from a Git directory, and with `modules` its
 * submodules', so a command interrupted once, such as by a restart, doesn't
 * fail every run after it. Only empty ones over an hour old go: a live
 * command holds one for seconds. Clearing never fails the checkout.
 */
const clearStaleLocks = Effect.fnUntraced(
  function* (gitDir: string, names: ReadonlySet<string>, modules: boolean) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;
    const pending = [gitDir];

    for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
      const entries = yield* fs.readDirectory(dir);
      // Between modules/ and a submodule's Git directory are the folders of
      // its path, which hold nothing else
      const isGitDir = entries.includes("HEAD");

      for (const name of entries) {
        const file = path.join(dir, name);

        if (isGitDir && names.has(name)) {
          const { mtime, size } = yield* fs.stat(file);
          const changed = Option.getOrUndefined(mtime)?.getTime() ?? now;

          if (
            ByteSize.toBigInt(size) === 0n &&
            now - changed > staleLockMillis
          ) {
            yield* fs.remove(file);
            yield* RunLog.warn(`Removed a stale Git lock, ${file}`);
          }
        } else if (
          modules &&
          ((isGitDir && name === "modules") ||
            (!isGitDir && (yield* fs.stat(file)).type === "Directory"))
        )
          pending.push(file);
      }
    }
  },
  Effect.catchCause((cause) =>
    RunLog.warn(`Couldn't clear stale Git locks: ${reason(cause)}`),
  ),
);

/** Fetch the branch's tip into `origin/<branch>`, without touching anything checked out. */
const fetch = (directory: string, branch: string) =>
  run(
    "git",
    [
      "fetch",
      "--quiet",
      "--no-write-fetch-head",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ],
    { cwd: directory, trusted: "" },
  );

/** Where a worktree goes: named `name`, in `within`, or else beside your own of the repository. */
export interface Place {
  readonly name: string;
  readonly within?: string;
}

/**
 * A clean worktree of the repository at the tip of `branch`: made the first
 * time, and reset to the tip after, with its submodules when it has any.
 * Returns its directory. It stays until it's removed.
 */
export const checkout = Effect.fnUntraced(function* (
  repo: string,
  branch: string,
  place: Place,
  listed?: Listed,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const trusted = yield* root;
  const tip = `refs/remotes/origin/${branch}`;

  const directory = yield* lockOf(repo).withPermit(
    Effect.gen(function* () {
      const base = yield* baseOf(repo, listed ?? (yield* Names.listed));

      const directory = path.join(
        place.within ?? path.join(trusted, base.folder),
        place.name,
      );

      const common = (yield* run(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd: base.directory, trusted: "" },
      )).trim();

      yield* clearStaleLocks(common, sharedLocks, false);
      yield* fetch(base.directory, branch);

      if (yield* fs.exists(directory)) {
        const options = { cwd: directory, trusted };

        const own = (yield* run(
          "git",
          ["rev-parse", "--absolute-git-dir"],
          options,
        )).trim();

        yield* clearStaleLocks(own, ownLocks, true);
        yield* run(
          "git",
          ["checkout", "--quiet", "--force", "--detach", tip],
          options,
        );
        // The second -f also removes untracked nested repositories, such as a
        // submodule the branch has since removed, which a job's `git add --all`
        // would otherwise commit back as a gitlink
        yield* run("git", ["clean", "--quiet", "-ffdx"], options);
      } else {
        yield* fs.makeDirectory(path.dirname(directory), { recursive: true });
        yield* run(
          "git",
          ["worktree", "add", "--quiet", "--detach", directory, tip],
          { cwd: base.directory, trusted: "" },
        );
      }

      return directory;
    }),
  );

  if (yield* fs.exists(path.join(directory, ".gitmodules")))
    yield* run(
      "git",
      ["submodule", "update", "--quiet", "--init", "--recursive", "--force"],
      { cwd: directory, trusted },
    );

  return directory;
});

/** Whether a directory is one Upkeep made in the worktree folder. */
const ours = Effect.fnUntraced(function* (directory: string) {
  const path = yield* Path.Path;
  const relative = path.relative(yield* root, directory);

  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    relative.split(path.sep).some((part) => part.startsWith(prefix))
  );
});

/**
 * Remove a worktree Upkeep made, leaving its commits where they are. One
 * with submodules, which Git won't remove, has its folder and its entry in
 * the repository deleted instead. Anything else, such as your own checkout,
 * is never touched. Removing never fails.
 */
export const remove = Effect.fnUntraced(
  function* (directory: string) {
    const fs = yield* FileSystem.FileSystem;

    if (!(yield* ours(directory)) || !(yield* fs.exists(directory))) return;

    const options = { cwd: directory, trusted: "" };

    const [common, own] = (yield* run(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--absolute-git-dir",
      ],
      options,
    ))
      .trim()
      .split("\n");

    // A checkout's own Git directory is its repository's: it isn't a worktree
    if (common === undefined || own === undefined || common === own) return;

    yield* run(
      "git",
      ["worktree", "remove", "--force", directory],
      options,
    ).pipe(
      Effect.catch(() =>
        Effect.gen(function* () {
          yield* fs.remove(directory, { recursive: true });
          yield* fs.remove(own, { recursive: true });
        }),
      ),
    );
  },
  (effect, directory) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        RunLog.warn(
          `Couldn't remove the worktree ${directory}: ${reason(cause)}`,
        ),
      ),
    ),
);

/**
 * The worktree or folder of worktrees of the agent that worked in
 * `directory`, or undefined when it isn't an agent's.
 */
const agentOf = Effect.fnUntraced(function* (directory: string) {
  const path = yield* Path.Path;
  const trusted = yield* root;
  const parts = path.relative(trusted, directory).split(path.sep);
  const [first = "", second = ""] = parts;

  if (first.startsWith(agentPrefix)) return path.join(trusted, first);

  if (second.startsWith(agentPrefix)) return path.join(trusted, first, second);

  return undefined;
});

/**
 * Remove the worktrees of the agent that worked in `directory`: its one
 * worktree, or its folder of several and everything in it. Anything that
 * isn't an agent's is never touched. Discarding never fails.
 */
export const discard = Effect.fnUntraced(
  function* (directory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const own = yield* agentOf(directory);

    if (own === undefined || !(yield* fs.exists(own))) return;

    if (path.dirname(own) !== (yield* root)) return yield* remove(own);

    // A folder of several holds each as <owner>/<name>
    for (const owner of yield* fs.readDirectory(own)) {
      const within = path.join(own, owner);

      if ((yield* fs.stat(within)).type !== "Directory") continue;

      for (const name of yield* fs.readDirectory(within))
        yield* remove(path.join(within, name));
    }

    yield* fs.remove(own, { recursive: true });
  },
  (effect, directory) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        RunLog.warn(
          `Couldn't remove the worktrees in ${directory}: ${reason(cause)}`,
        ),
      ),
    ),
);

/** An agent's worktree, or folder of several, and when it last changed. */
interface AgentWorktrees {
  readonly directory: string;
  readonly changed: number;
}

/** The agents of a kind that have worktrees here. */
export const agents = Effect.fnUntraced(function* (kind: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  const trusted = yield* root;
  const named = nameOf(["agent", kind, ""]);
  const found: Array<AgentWorktrees> = [];

  if (!(yield* fs.exists(trusted))) return found;

  const add = Effect.fnUntraced(function* (directory: string) {
    const { mtime } = yield* fs.stat(directory);

    found.push({
      directory,
      changed: Option.getOrUndefined(mtime)?.getTime() ?? now,
    });
  });

  for (const folder of yield* fs.readDirectory(trusted)) {
    const within = path.join(trusted, folder);

    if (folder.startsWith(named)) yield* add(within);
    else if (
      !folder.startsWith(prefix) &&
      (yield* fs.stat(within)).type === "Directory"
    )
      for (const name of yield* fs.readDirectory(within))
        if (name.startsWith(named)) yield* add(path.join(within, name));
  }

  return found;
});

/** How old a run's worktree is before it's taken as left by one that died. */
const staleRunMillis = 12 * 60 * 60 * 1000;

/**
 * Remove run worktrees left by a run that died before it could, such as in a
 * restart, once they're old enough that no run still has them. An agent's
 * are left alone.
 */
const tidy = Effect.fnUntraced(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;
    const trusted = yield* root;

    if (!(yield* fs.exists(trusted))) return;

    for (const folder of yield* fs.readDirectory(trusted)) {
      const within = path.join(trusted, folder);

      if (
        folder.startsWith(prefix) ||
        (yield* fs.stat(within)).type !== "Directory"
      )
        continue;

      for (const name of yield* fs.readDirectory(within)) {
        if (!name.startsWith(prefix) || name.startsWith(agentPrefix)) continue;

        const directory = path.join(within, name);
        const { mtime } = yield* fs.stat(directory);
        const changed = Option.getOrUndefined(mtime)?.getTime() ?? now;

        if (now - changed > staleRunMillis) yield* remove(directory);
      }
    }
  },
  Effect.catchCause((cause) =>
    RunLog.warn(`Couldn't tidy old worktrees: ${reason(cause)}`),
  ),
);

/** A name for worktrees: Upkeep's prefix, then the parts, made safe for a folder. */
const nameOf = (parts: ReadonlyArray<string>) =>
  `${prefix}${parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")}`;

/**
 * The worktrees of one run of a job, all removed when its scope closes.
 * `checkout` gives the run's worktree of a repository, made the first time
 * and reset to the branch's tip each time after.
 */
export const forRun = Effect.fnUntraced(function* (job: string) {
  const trusted = yield* root;
  const listed = yield* Effect.cached(Names.listed);
  const name = nameOf([job, newId()]);
  const directories = new Set<string>();

  yield* tidy();
  yield* Effect.addFinalizer(() =>
    Effect.forEach(directories, (directory) => remove(directory), {
      discard: true,
    }),
  );

  return {
    trusted,
    checkout: (repo: string, branch: string) =>
      Effect.gen(function* () {
        const directory = yield* checkout(
          repo,
          branch,
          { name },
          yield* listed,
        );

        directories.add(directory);

        return directory;
      }),
  };
});

export type Run = Effect.Success<ReturnType<typeof forRun>>;

/**
 * Where an agent's worktrees go, named for what it's doing and `id`: one
 * repository's beside your own of it, several in a folder of their own, by
 * owner and name. They stay until they're given to `discard`.
 */
export const forAgent = Effect.fnUntraced(function* (
  kind: string,
  several: boolean,
  id: string = newId(),
) {
  const path = yield* Path.Path;
  const name = nameOf(["agent", kind, id]);
  const folder = several ? path.join(yield* root, name) : undefined;

  return {
    /** The folder holding several, or undefined for one. */
    folder,
    place: (repo: string): Place =>
      folder === undefined
        ? { name }
        : {
            name: repo.split("/").at(-1) ?? repo,
            within: path.join(folder, repo.split("/")[0] ?? ""),
          },
  };
});
