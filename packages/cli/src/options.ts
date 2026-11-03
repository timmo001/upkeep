/**
 * Settings read behind the environment: the admin's `admin.env`, and a JSON
 * file such as the Home Assistant app's `/data/options.json`.
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

const configRoot = Config.String("XDG_CONFIG_HOME").pipe(
  Config.orElse(() =>
    Config.String("HOME").pipe(Config.map((home) => `${home}/.config`)),
  ),
);

/**
 * Settings from `~/.config/upkeep/admin.env`, read behind the environment,
 * so the CLI, its MCP server and the OpenCode plugin reach the server however
 * they were started.
 */
export const layerAdminEnv = ConfigProvider.layerAdd(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* Config.option(configRoot);

    if (Option.isNone(root)) return ConfigProvider.fromUnknown({});

    const path = `${root.value}/upkeep/admin.env`;

    if (!(yield* fs.exists(path))) return ConfigProvider.fromUnknown({});

    return yield* ConfigProvider.fromDotEnv({ path });
  }),
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
