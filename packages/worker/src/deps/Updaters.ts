/**
 * The updater adapters: each one says whether a repository uses its updater
 * and translates that updater's config into Upkeep's Policy, so nothing
 * after this knows which updater a repository uses. Renovate is the only one
 * so far; a Dependabot adapter for .github/dependabot.yml fits the same
 * shape.
 */
import { Context, Effect, Layer, Option } from "effect";
import type { DepsError, Policy } from "./Policy";
import * as Renovate from "./Renovate";

/** Reads a file from a GitHub repository, none when it isn't there. */
export type ReadFile = Renovate.ReadFile;

export interface Adapter {
  readonly name: string;
  /** The config files it looks for, in the order it reads them. */
  readonly files: ReadonlyArray<string>;
  /** The config file of the ones present that it reads, if any. */
  readonly detect: (present: ReadonlyArray<string>) => Option.Option<string>;
  /** Translate the config into Upkeep's Policy. */
  readonly read: (
    repo: string,
    file: string,
    readFile: ReadFile,
  ) => Effect.Effect<Policy, DepsError>;
}

const firstPresent =
  (files: ReadonlyArray<string>) => (present: ReadonlyArray<string>) =>
    Option.fromNullishOr(files.find((file) => present.includes(file)));

export const renovate: Adapter = {
  name: "renovate",
  files: Renovate.configFiles,
  detect: firstPresent(Renovate.configFiles),
  read: Renovate.read,
};

/** The adapter a repository uses and the file it reads. */
export interface Detected {
  readonly adapter: Adapter;
  readonly file: string;
}

export class Updaters extends Context.Service<
  Updaters,
  {
    /** Every config file any adapter looks for. */
    readonly files: ReadonlyArray<string>;
    /** The first adapter whose config is among the files present. */
    readonly detect: (
      present: ReadonlyArray<string>,
    ) => Option.Option<Detected>;
    readonly read: (
      repo: string,
      detected: Detected,
      readFile: ReadFile,
    ) => Effect.Effect<Policy, DepsError>;
  }
>()("@upkeep/worker/deps/Updaters") {
  static readonly make = (adapters: ReadonlyArray<Adapter>) =>
    Updaters.of({
      files: [...new Set(adapters.flatMap((adapter) => adapter.files))],
      detect: (present) => {
        for (const adapter of adapters) {
          const file = adapter.detect(present);

          if (Option.isSome(file))
            return Option.some({ adapter, file: file.value });
        }

        return Option.none();
      },
      read: (repo, { adapter, file }, readFile) =>
        adapter.read(repo, file, readFile),
    });

  static readonly layer = Layer.succeed(Updaters, Updaters.make([renovate]));
}
