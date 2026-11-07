/**
 * Tells you when something new needs you: once a minute the worker reads
 * Upkeep's status and runs its `notify` command for each item it hasn't seen,
 * pointing at the item's dashboard page. Nothing is said for green runs, and
 * the first read after a start only records what's there, so a restart
 * doesn't repeat old notifications.
 */
import { Client, type Domain } from "@upkeep/api";
import { Config, Effect, Option, Ref } from "effect";
import { reason } from "./Failure";
import { run } from "./jobs/bump";
import * as Settings from "./settings";

/** One item's identity, so the same item isn't told twice. */
const key = (item: Domain.NeedsYou) =>
  `${item.kind}:${item.path}:${item.title}`;

/** The items in `now` that weren't in `before`. */
export const fresh = (
  before: ReadonlySet<string>,
  now: ReadonlyArray<Domain.NeedsYou>,
) => now.filter((item) => !before.has(key(item)));

/** A command's arguments with `{title}` and `{url}` filled in. */
export const fill = (
  command: ReadonlyArray<string>,
  item: Domain.NeedsYou,
  dashboard: string,
) =>
  command.map((arg) =>
    arg
      .replaceAll("{title}", item.title)
      .replaceAll("{url}", `${dashboard.replace(/\/+$/, "")}/${item.path}`),
  );

/** A check to repeat: read the status and tell you what's new since the last one. */
export const make = Effect.gen(function* () {
  const client = yield* Client;

  const seen = yield* Ref.make<Option.Option<ReadonlySet<string>>>(
    Option.none(),
  );

  return Effect.gen(function* () {
    const settings = yield* Settings.load();

    if (settings.notify === undefined) return;

    const notify = settings.notify;
    const status = yield* client.work.status();

    const before = yield* Ref.getAndSet(
      seen,
      Option.some(new Set(status.needs.map(key))),
    );

    if (Option.isNone(before)) return;

    const dashboard =
      notify.dashboard ?? (yield* Config.String("UPKEEP_SERVER"));

    for (const item of fresh(before.value, status.needs)) {
      const [program = "", ...args] = fill(notify.command, item, dashboard);

      yield* run(program, args, { cwd: process.cwd(), trusted: "" }).pipe(
        Effect.andThen(Effect.logInfo(`Told you: ${item.title}`)),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Couldn't tell you ${item.title}: ${reason(cause)}`,
          ),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logDebug("Couldn't check what needs you", cause),
    ),
  );
});
