/**
 * The release-publish job: publish the release you confirmed on the Releases
 * page. The comparison and tag must still be the server's, and the
 * repository needs a `publish` recipe in this worker's settings. The work is
 * done in a worktree of the job's clone, with this machine's own Git and
 * GitHub login, so the release starts the repository's workflows as yours.
 */
import type { Domain } from "@upkeep/api";
import { Effect, FileSystem, Path } from "effect";
import { ReleaseError } from "../releases/Changes";
import { publish } from "../releases/Publish";
import { pushed, Reporter, summary } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { skipped } from "../Worker";
import { bareClone, cacheRoot, settingsFor } from "./unreleased";

export const releasePublish = Effect.fnUntraced(function* (
  command: Domain.Command | null,
) {
  if (command?.kind !== "release-publish") {
    yield* RunLog.info(
      "No release to publish: start one from the Releases page",
    );

    return skipped;
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const reporter = yield* Reporter;
  const { repo, tag } = command;
  const entry = yield* reporter.release(repo);
  const snapshot = entry.snapshot;

  if (
    snapshot === null ||
    snapshot.id !== command.snapshot ||
    entry.stale ||
    !snapshot.complete
  )
    return yield* new ReleaseError({
      message:
        "The comparison changed since you confirmed the release; refresh the Releases page and confirm again",
    });

  if (entry.nextVersion !== tag)
    return yield* new ReleaseError({
      message: `The release would now be ${entry.nextVersion ?? "none"}, not ${tag}; confirm again`,
    });

  const config = settingsFor(yield* Settings.load(), repo)?.publish;

  if (config === undefined)
    return yield* new ReleaseError({
      message: `This worker has no releases.repos["${repo}"].publish in its settings`,
    });

  const root = yield* cacheRoot;
  const clone = yield* bareClone(repo, root);
  const scratch = path.join(root, "publish", repo);

  yield* fs.makeDirectory(scratch, { recursive: true });
  yield* RunLog.info(`Publishing ${repo} ${tag} from ${entry.branch}`);

  const released = yield* publish({
    repo,
    branch: entry.branch,
    snapshot,
    tag,
    versionFiles: config.versionFiles,
    generatedFiles: config.generatedFiles ?? [],
    commands: config.commands,
    notes: command.notes,
    notesMode: command.notesMode,
    clone,
    scratch,
    trusted: root,
  });

  if (released.pushed !== null)
    yield* pushed(repo, released.pushed, `Release ${tag}`);

  yield* summary(
    `Released ${repo.split("/").at(-1) ?? repo} ${tag}: ${released.url}`,
  );
});
