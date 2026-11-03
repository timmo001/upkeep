/**
 * The worker's own settings, read from a JSON file: `$UPKEEP_CONFIG`, or
 * `upkeep/config.json` in the XDG config directory. It holds what can't be
 * derived, such as the checks of a repository that doesn't follow
 * groundwork's tasks. A missing file means every default.
 */
import { Config, Effect, FileSystem, Schema } from "effect";

/** How the bump job treats one consumer. */
const BumpRepo = Schema.Struct({
  /** Shell commands run before a push, in place of `mise run check` and `build`. */
  checks: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const Settings = Schema.Struct({
  bump: Schema.optionalKey(
    Schema.Struct({
      /** By repository, as `owner/name`. */
      repos: Schema.optionalKey(Schema.Record(Schema.String, BumpRepo)),
    }),
  ),
});

export type Settings = typeof Settings.Type;

const path = Config.String("UPKEEP_CONFIG").pipe(
  Config.orElse(() =>
    Config.String("XDG_CONFIG_HOME").pipe(
      Config.orElse(() =>
        Config.String("HOME").pipe(Config.map((home) => `${home}/.config`)),
      ),
      Config.map((root) => `${root}/upkeep/config.json`),
    ),
  ),
);

/** Read the settings, or the defaults when there's no file. */
export const load = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* path;

  if (!(yield* fs.exists(file))) return {} satisfies Settings;

  return yield* fs
    .readFileString(file)
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Settings)),
      ),
    );
});
