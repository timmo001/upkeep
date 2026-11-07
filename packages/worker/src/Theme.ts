/**
 * Follows the desktop's Omarchy theme for the dashboard: on start and on each
 * switch, the worker sends the theme's name and `colors.toml` to the server,
 * which offers it in the dashboard's theme picker. A machine without Omarchy
 * sends nothing, so it never clears another worker's theme. A send that fails
 * is tried again until the server takes it or the next switch replaces it.
 */
import { Client, type Domain } from "@upkeep/api";
import {
  Config,
  Effect,
  FileSystem,
  Option,
  Path,
  Schedule,
  Stream,
} from "effect";

/** `tokyo-night` reads as `Tokyo Night`, as `omarchy theme current` shows it. */
const displayName = (slug: string) =>
  slug
    .trim()
    .split("-")
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

/** Omarchy's `current` folder, in `$XDG_STATE_HOME`, by default `~/.local/state`. */
const currentFolder = Effect.gen(function* () {
  const path = yield* Path.Path;
  const home = yield* Config.String("HOME").pipe(Config.withDefault(""));

  const stateHome = yield* Config.String("XDG_STATE_HOME").pipe(
    Config.withDefault(path.join(home, ".local", "state")),
  );

  return path.join(stateHome, "omarchy", "current");
});

/** The Omarchy theme in use, or none where there's no Omarchy. */
const read = (current: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const colors = yield* fs.readFileString(
      path.join(current, "theme", "colors.toml"),
    );

    const slug = yield* fs
      .readFileString(path.join(current, "theme.name"))
      .pipe(Effect.orElseSucceed(() => ""));

    return { name: displayName(slug) || "Omarchy", colors };
  }).pipe(Effect.option);

/**
 * The Omarchy theme in use, then each one Omarchy switches to. A switch
 * replaces the `theme` folder and rewrites `theme.name`, several writes that
 * are read once they've settled.
 */
const themes = (current: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const switches = fs.watch(current).pipe(
      Stream.debounce("250 millis"),
      Stream.catchCause(() => Stream.empty),
    );

    return Stream.make(current).pipe(
      Stream.concat(Stream.as(switches, current)),
      Stream.mapEffect(read),
      Stream.filter(Option.isSome),
      Stream.map((theme) => theme.value),
      Stream.changesWith(
        (before: Domain.OmarchyTheme, after: Domain.OmarchyTheme) =>
          before.name === after.name && before.colors === after.colors,
      ),
    );
  }).pipe(Stream.unwrap);

/** Send the desktop's theme to the server, following it until the worker stops. */
export const follow = Effect.gen(function* () {
  const client = yield* Client;
  const current = yield* currentFolder;

  const send = (theme: Domain.OmarchyTheme) =>
    client.work.putTheme({ payload: theme }).pipe(
      Effect.tapCause((cause) =>
        Effect.logDebug("Couldn't send the Omarchy theme", cause),
      ),
      Effect.retry(Schedule.spaced("30 seconds")),
      Effect.andThen(Effect.logInfo(`Sent the Omarchy theme ${theme.name}`)),
    );

  yield* themes(current).pipe(
    Stream.switchMap((theme) => Stream.fromEffect(send(theme))),
    Stream.runDrain,
  );
});
