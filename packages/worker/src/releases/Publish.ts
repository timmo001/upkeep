/**
 * Publishing a release from the Releases page: in a worktree of the
 * comparison's commit, set the new version in the version files, run the
 * repository's commands, check they changed nothing else, commit and push the
 * version with its tag in one atomic push, and create the GitHub release with
 * generated notes. Every step checks GitHub still has the release, branch and
 * tag the page was confirmed on. Ported from `dot git releases publish`.
 */
import { Api, Release } from "@timmo001/effect-gh";
import type { Domain } from "@upkeep/api";
import {
  Cause,
  Effect,
  FileSystem,
  Option,
  Path,
  Predicate,
  Result,
  Schema,
} from "effect";
import { run } from "../Command";
import { reason } from "../Failure";
import * as RunLog from "../RunLog";
import type { VersionFile } from "../settings";
import { git, ReleaseError, why } from "./Changes";

const Manifest = Schema.fromJsonString(
  Schema.Struct({ version: Schema.String }),
);

const JsonManifest = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown),
);

const pathOf = (file: VersionFile) =>
  Predicate.isString(file) ? file : file.path;

/** What each closing bracket closes. */
const closing = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
]);

/** A JSON manifest with a new top-level version, every other byte kept. */
const withManifestVersion = (
  content: string,
  version: string,
): Result.Result<string, string> => {
  const original = Schema.decodeOption(JsonManifest)(content);

  if (Option.isNone(original)) return Result.fail("It isn't a JSON object");

  const expected = JSON.stringify({ ...original.value, version });

  for (const match of content.matchAll(
    /("version"\s*:\s*)"(?:[^"\\]|\\.)*"/g,
  )) {
    const candidate =
      content.slice(0, match.index) +
      match[1] +
      JSON.stringify(version) +
      content.slice(match.index + match[0].length);

    const decoded = Schema.decodeOption(JsonManifest)(candidate);

    if (Option.isSome(decoded) && JSON.stringify(decoded.value) === expected)
      return Result.succeed(candidate);
  }

  return Result.fail(
    "Couldn't set its top-level version while keeping its formatting",
  );
};

/**
 * A `setup.py`'s one literal `version=` keyword in its one `setup(...)`
 * call, found by tokenising rather than running it, so a comment or string
 * can't pass for it.
 */
const setupVersion = (content: string, path: string) => {
  const invalid = Result.fail(
    `${path} must have one literal version keyword in a single setup call`,
  );

  const tokens = [
    ...content.matchAll(
      /#[^\r\n]*|'''(?:\\[\s\S]|(?!''')[^\\])*'''|"""(?:\\[\s\S]|(?!""")[^\\])*"""|'(?:\\[\s\S]|[^'\\\r\n])*'|"(?:\\[\s\S]|[^"\\\r\n])*"|[A-Za-z_]\w*|\s+|[^\s]/g,
    ),
  ].filter((token) => !/^(?:\s|#)/.test(token[0]));

  const text = (index: number) => tokens[index]?.[0];

  const calls = tokens.flatMap((token, index) =>
    token[0] === "setup" && text(index + 1) === "(" ? [index + 1] : [],
  );

  const [opening] = calls;

  if (
    calls.length !== 1 ||
    opening === undefined ||
    tokens.some((token) => token[0] === "'" || token[0] === '"') ||
    text(opening - 2) === "def" ||
    (text(opening - 2) === "." && text(opening - 3) !== "setuptools")
  )
    return invalid;

  const stack = ["("];
  let literal: RegExpExecArray | undefined;

  for (let index = opening + 1; index < tokens.length; index++) {
    const token = text(index) ?? "";

    if (stack.length === 1) {
      if (token === "*" && text(index + 1) === "*") return invalid;

      if (token === "version" && text(index + 1) === "=") {
        if (
          literal !== undefined ||
          !["(", ","].includes(text(index - 1) ?? "")
        )
          return invalid;

        literal = tokens[index + 2];

        if (
          literal === undefined ||
          !/^(['"])\d+(?:\.\d+)+\1$/.test(literal[0]) ||
          ![",", ")"].includes(text(index + 3) ?? "")
        )
          return invalid;
      }
    }

    if (["(", "[", "{"].includes(token)) stack.push(token);
    else if (closing.has(token)) {
      if (stack.pop() !== closing.get(token)) return invalid;

      if (stack.length === 0) break;
    }
  }

  if (stack.length > 0 || literal === undefined) return invalid;

  return Result.succeed({ literal, index: literal.index });
};

/**
 * Read a version file's version, and with `version`, write the new one,
 * keeping every other byte.
 */
export const prepareVersion = (
  content: string,
  file: VersionFile,
  version?: string,
): Result.Result<
  { readonly before: string; readonly content: string },
  string
> => {
  if (Predicate.isString(file)) {
    const manifest = Schema.decodeOption(Manifest)(content);

    if (Option.isNone(manifest))
      return Result.fail(`${file} has no top-level version`);

    if (version === undefined)
      return Result.succeed({ before: manifest.value.version, content });

    return Result.map(withManifestVersion(content, version), (next) => ({
      before: manifest.value.version,
      content: next,
    }));
  }

  return Result.flatMap(
    setupVersion(content, file.path),
    ({ literal, index }) => {
      const before = literal[0].slice(1, -1);

      if (version === undefined) return Result.succeed({ before, content });

      if (!/^\d+(?:\.\d+)+$/.test(version))
        return Result.fail(
          `${file.path} takes a plain numeric version, not ${version}`,
        );

      return Result.succeed({
        before,
        content:
          content.slice(0, index + 1) +
          version +
          content.slice(index + literal[0].length - 1),
      });
    },
  );
};

/** How a repository publishes, with each version file as `head` has it. */
export const readRecipe = Effect.fnUntraced(function* (
  directory: string,
  head: string,
  publish: {
    readonly versionFiles: ReadonlyArray<VersionFile>;
    readonly generatedFiles?: ReadonlyArray<string>;
    readonly commands: ReadonlyArray<ReadonlyArray<string>>;
  },
) {
  const versionFiles = yield* Effect.forEach(publish.versionFiles, (file) =>
    git(directory, ["show", `${head}:${pathOf(file)}`]).pipe(
      Effect.map((content) => {
        const read = prepareVersion(content, file);

        return Result.isSuccess(read)
          ? { path: pathOf(file), before: read.success.before, error: null }
          : { path: pathOf(file), before: null, error: read.failure };
      }),
      Effect.catch((error) =>
        Effect.succeed({
          path: pathOf(file),
          before: null,
          error: `Couldn't read it at ${head.slice(0, 7)}: ${error.message}`,
        }),
      ),
    ),
  );

  return {
    versionFiles,
    commands: publish.commands,
    generatedFiles: publish.generatedFiles ?? [],
  } satisfies Domain.ReleaseRecipe;
});

const StableRelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String),
});

const ReleaseList = Schema.Array(
  Schema.Struct({ draft: Schema.Boolean, prerelease: Schema.Boolean }),
);

/**
 * A repository's latest stable release, or null when it has never had one.
 * GitHub answers 404 both when there's none and when no stable release is
 * marked latest, so the list tells them apart.
 */
export const latestStable = Effect.fnUntraced(function* (repo: string) {
  const latest = yield* Api.json(
    { endpoint: `repos/${repo}/releases/latest`, method: "GET" },
    StableRelease,
  ).pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      (error) => /\b404\b|Not Found/.test(why(error)),
      () => Effect.succeed(Option.none()),
    ),
  );

  if (Option.isSome(latest)) {
    if (
      latest.value.draft ||
      latest.value.prerelease ||
      latest.value.published_at === null
    )
      return yield* new ReleaseError({
        message: "No published stable release is available",
      });

    return latest.value;
  }

  const pages = yield* Api.pages(
    {
      endpoint: `repos/${repo}/releases`,
      method: "GET",
      query: { per_page: 100 },
    },
    ReleaseList,
  );

  if (pages.flat().some((release) => !release.draft && !release.prerelease))
    return yield* new ReleaseError({
      message: "GitHub has stable releases, but none is marked as the latest",
    });

  return null;
});

const Body = Schema.Struct({ body: Schema.NullOr(Schema.String) });

/** What to publish, as the page confirmed it and the worker read it. */
export interface Publication {
  readonly repo: string;
  readonly branch: string;
  readonly snapshot: Domain.ReleaseSnapshot;
  readonly tag: string;
  readonly versionFiles: ReadonlyArray<VersionFile>;
  readonly generatedFiles: ReadonlyArray<string>;
  readonly commands: ReadonlyArray<ReadonlyArray<string>>;
  readonly notes: string | null;
  readonly notesMode: "prepend" | "replace";
  /** The repository's clone, which the worktree is added to. */
  readonly clone: string;
  /** Where the worktree and notes go. */
  readonly scratch: string;
  /** Where mise trusts config. */
  readonly trusted: string;
}

/**
 * Publish a release, returning its page, the commit it's at, and the version
 * commit when one was pushed.
 */
export const publish = Effect.fnUntraced(function* (release: Publication) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { repo, branch, snapshot, tag, clone } = release;
  const version = tag.replace(/^v/, "");

  const fail = (message: string) => new ReleaseError({ message });

  /** GitHub still has the release, branch and tag the page was confirmed on. */
  const verifyRemote = Effect.fnUntraced(function* (
    head: string,
    tagged = false,
  ) {
    yield* RunLog.info(
      "Checking the latest stable release, the branch and the new tag on GitHub",
    );

    const latest = yield* latestStable(repo);
    const baseline = snapshot.releaseTag;

    const refs = (yield* git(clone, [
      "ls-remote",
      "origin",
      `refs/heads/${branch}`,
      ...(baseline === null
        ? []
        : [`refs/tags/${baseline}`, `refs/tags/${baseline}^{}`]),
      `refs/tags/${tag}`,
    ]))
      .trim()
      .split("\n")
      .map((line) => line.split(/\s+/));

    const ref = (name: string) => refs.find(([, key]) => key === name)?.[0];

    if (
      (latest?.tag_name ?? null) !== baseline ||
      ref(`refs/heads/${branch}`) !== head ||
      (baseline !== null &&
        (ref(`refs/tags/${baseline}^{}`) ?? ref(`refs/tags/${baseline}`)) !==
          snapshot.releaseCommit)
    )
      return yield* fail(
        "The last release or the branch moved on GitHub; refresh the comparison and confirm again",
      );

    if (tagged && ref(`refs/tags/${tag}`) !== head)
      return yield* fail(
        `Tag ${tag} doesn't point at the prepared commit; look at it on GitHub before trying again`,
      );

    if (!tagged && ref(`refs/tags/${tag}`) !== undefined)
      return yield* fail(
        `Tag ${tag} already exists; look at it on GitHub before releasing again`,
      );
  });

  yield* git(clone, [
    "fetch",
    "--quiet",
    "--no-tags",
    "origin",
    `+refs/heads/${branch}:refs/upkeep/head`,
  ]);
  yield* verifyRemote(snapshot.head);

  const prepared = yield* Effect.forEach(release.versionFiles, (file) =>
    Effect.gen(function* () {
      const name = pathOf(file);

      const mode = (yield* git(clone, [
        "ls-tree",
        snapshot.head,
        "--",
        name,
      ])).split(" ")[0];

      if (mode !== "100644" && mode !== "100755")
        return yield* fail(`${name} must be a tracked, regular version file`);

      const original = yield* git(clone, ["show", `${snapshot.head}:${name}`]);
      const read = prepareVersion(original, file, version);

      if (Result.isFailure(read)) return yield* fail(read.failure);

      // A first release takes whatever version the files already have
      if (
        snapshot.releaseTag !== null &&
        ![snapshot.releaseTag.replace(/^v/, ""), version].includes(
          read.success.before,
        )
      )
        return yield* fail(
          `${name} has version ${read.success.before}; reconcile it with ${tag} first`,
        );

      return { file, path: name, before: read.success.before };
    }),
  );

  const changed = prepared.filter(({ before }) => before !== version);
  const preparing = changed.length > 0 || release.commands.length > 0;
  // Regenerated files only go in with a version commit
  const generated = changed.length > 0 ? release.generatedFiles : [];

  const extraGenerated = generated.filter(
    (name) => !changed.some((file) => file.path === name),
  );

  for (const file of prepared)
    yield* RunLog.info(
      `${file.path}: ${file.before} -> ${version}${file.before === version ? " (already set)" : ""}`,
    );

  const worktree = path.join(release.scratch, "worktree");
  let target = snapshot.head;

  const runStep = Effect.fnUntraced(function* (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
  ) {
    yield* RunLog.info(`$ ${[command, ...args].join(" ")}`);

    const output = yield* run(command, args, {
      cwd,
      trusted: release.trusted,
    }).pipe(Effect.mapError((error) => fail(reason(Cause.fail(error)))));

    for (const line of output
      .trim()
      .split("\n")
      .filter((each) => each !== ""))
      yield* RunLog.info(line);
  });

  const prepare = Effect.gen(function* () {
    yield* fs.remove(worktree, { recursive: true }).pipe(Effect.ignore);
    yield* git(clone, ["worktree", "prune"]);
    yield* runStep(
      "git",
      ["worktree", "add", "--detach", worktree, snapshot.head],
      clone,
    );
    yield* runStep(
      "git",
      ["submodule", "update", "--quiet", "--init", "--recursive"],
      worktree,
    );

    for (const file of changed) {
      const location = yield* fs
        .realPath(path.join(worktree, file.path))
        .pipe(Effect.mapError((error) => fail(why(error))));

      const root = yield* fs
        .realPath(worktree)
        .pipe(Effect.mapError((error) => fail(why(error))));

      if (path.relative(root, location).startsWith(".."))
        return yield* fail(`${file.path} leaves the worktree`);

      const content = yield* fs
        .readFileString(location)
        .pipe(Effect.mapError((error) => fail(why(error))));

      const next = prepareVersion(content, file.file, version);

      if (Result.isFailure(next)) return yield* fail(next.failure);

      yield* fs
        .writeFileString(location, next.success.content)
        .pipe(Effect.mapError((error) => fail(why(error))));
    }

    for (const [command = "", ...args] of release.commands)
      yield* runStep(command, args, worktree);

    yield* RunLog.info(
      "Checking the worktree has only the agreed version changes",
    );

    const paths = (yield* git(worktree, ["diff", "HEAD", "--name-only", "-z"]))
      .split("\0")
      .filter((name) => name !== "");

    const untracked = (yield* git(worktree, [
      "ls-files",
      "--others",
      "--exclude-standard",
    ])).trim();

    if (
      untracked !== "" ||
      paths.some(
        (name) =>
          !changed.some((file) => file.path === name) &&
          !generated.includes(name),
      )
    )
      return yield* fail(
        `The commands changed files beyond the version: ${[...paths, ...untracked.split("\n")].filter((name) => name !== "").join(", ")}`,
      );

    for (const file of prepared) {
      const original = yield* git(clone, [
        "show",
        `${snapshot.head}:${file.path}`,
      ]);

      const actual = yield* fs
        .readFileString(path.join(worktree, file.path))
        .pipe(Effect.mapError((error) => fail(why(error))));

      // A regenerated version file may change elsewhere, but must have the version
      if (generated.includes(file.path)) {
        const read = prepareVersion(actual, file.file);

        if (Result.isFailure(read) || read.success.before !== version)
          return yield* fail(
            `The commands left ${file.path} without ${version}`,
          );

        continue;
      }

      const expected =
        file.before === version
          ? Result.succeed(original)
          : Result.map(
              prepareVersion(original, file.file, version),
              ({ content }) => content,
            );

      if (Result.isFailure(expected) || actual !== expected.success)
        return yield* fail(
          `The commands changed ${file.path} beyond its version`,
        );
    }

    if ((yield* git(worktree, ["rev-parse", "HEAD"])).trim() !== snapshot.head)
      return yield* fail("The commands moved the worktree's HEAD");

    yield* verifyRemote(snapshot.head);

    if (changed.length > 0) {
      const regenerated = extraGenerated.filter((name) => paths.includes(name));

      const diff = [
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-prefix",
        snapshot.head,
      ];

      const approved = yield* git(worktree, diff);

      yield* runStep(
        "git",
        [
          "commit",
          "--quiet",
          "--no-verify",
          "-m",
          `Release ${tag}`,
          "--",
          ...changed.map((file) => file.path),
          ...regenerated,
        ],
        worktree,
      );

      target = (yield* git(worktree, ["rev-parse", "HEAD"])).trim();

      if (
        (yield* git(worktree, ["rev-parse", `${target}^`])).trim() !==
          snapshot.head ||
        (yield* git(worktree, [...diff, target])) !== approved
      )
        return yield* fail(
          "The version commit differs from the checked changes",
        );
    }
  });

  if (preparing) yield* RunLog.info(`Preparing ${tag} in ${worktree}`);
  else
    yield* RunLog.info(
      `Tagging ${tag} at ${snapshot.head.slice(0, 7)}: no version files to change and no commands to run`,
    );

  const pushed = yield* Effect.gen(function* () {
    if (preparing) yield* prepare;

    yield* verifyRemote(snapshot.head);
    yield* runStep(
      "git",
      [
        "push",
        "--quiet",
        "--atomic",
        "origin",
        ...(changed.length > 0 ? [`${target}:refs/heads/${branch}`] : []),
        `${target}:refs/tags/${tag}`,
      ],
      preparing ? worktree : clone,
    );

    yield* RunLog.info(
      changed.length > 0
        ? `Pushed the version commit ${target.slice(0, 7)} and tag ${tag}`
        : `Pushed tag ${tag} at ${target.slice(0, 7)}`,
    );

    return changed.length > 0 ? target : null;
  }).pipe(
    Effect.ensuring(
      preparing
        ? git(clone, [
            "worktree",
            "remove",
            "--force",
            "--force",
            worktree,
          ]).pipe(Effect.ignore)
        : Effect.void,
    ),
  );

  yield* verifyRemote(target, true);

  const since =
    snapshot.releaseTag === null
      ? "covering the whole history"
      : `since ${snapshot.releaseTag}`;

  const notesFile = path.join(release.scratch, `notes-${tag}.md`);

  const writeNotes = (content: string) =>
    fs
      .writeFileString(notesFile, `${content}\n`)
      .pipe(Effect.mapError((error) => fail(why(error))));

  yield* RunLog.info(
    release.notes !== null && release.notesMode === "replace"
      ? `Creating GitHub release ${tag} with your notes`
      : `Creating GitHub release ${tag} with notes GitHub generates ${since}`,
  );

  if (release.notes !== null && release.notesMode === "replace")
    yield* writeNotes(release.notes);

  const { url } = yield* Release.create({
    repo,
    tag,
    verifyTag: true,
    ...(release.notes !== null && release.notesMode === "replace"
      ? { notesFile }
      : {
          generateNotes: true,
          ...(snapshot.releaseTag !== null && {
            notesStartTag: snapshot.releaseTag,
          }),
        }),
  });

  if (release.notes !== null && release.notesMode === "prepend") {
    const notes = release.notes;

    yield* RunLog.info("Putting your notes before the generated ones");

    yield* Effect.gen(function* () {
      const { body } = yield* Api.json(
        { endpoint: `repos/${repo}/releases/tags/${tag}`, method: "GET" },
        Body,
      );

      yield* writeNotes(
        [notes, (body ?? "").trim()].filter((part) => part !== "").join("\n\n"),
      );
      yield* Release.edit({ repo, tag, notesFile });
    }).pipe(
      Effect.mapError((error) =>
        fail(
          `Release ${url} was created, but your notes couldn't be added: ${why(error)}`,
        ),
      ),
    );
  }

  yield* fs.remove(notesFile).pipe(Effect.ignore);
  yield* RunLog.info(`Created ${url}`);
  yield* RunLog.info(
    `Its workflows run from the release: https://github.com/${repo}/actions`,
  );

  return { url, target, pushed };
});
