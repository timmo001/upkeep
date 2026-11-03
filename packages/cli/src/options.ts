/**
 * Settings from a JSON file, such as the Home Assistant app's
 * `/data/options.json`, read behind the environment.
 */
import {
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Option,
  Predicate,
  Schema,
} from "effect";

const Options = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown),
);

/**
 * Settings from the JSON file at `$UPKEEP_OPTIONS`. Keys are lowercase,
 * without the `UPKEEP_` prefix: `keep_days` sets `UPKEEP_KEEP_DAYS`.
 */
export const layerOptions = ConfigProvider.layerAdd(
  Effect.gen(function* () {
    const file = yield* Config.option(Config.String("UPKEEP_OPTIONS"));

    if (Option.isNone(file)) return ConfigProvider.fromUnknown({});

    const fs = yield* FileSystem.FileSystem;

    const options = yield* Schema.decodeEffect(Options)(
      yield* fs.readFileString(file.value),
    );

    return ConfigProvider.fromUnknown(options).pipe(
      ConfigProvider.mapInput((path) =>
        path.map((segment) =>
          Predicate.isString(segment)
            ? segment.toLowerCase().replace(/^upkeep_/, "")
            : segment,
        ),
      ),
    );
  }),
);
