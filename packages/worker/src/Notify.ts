/**
 * Tells you when something new needs you: once a minute the worker reads
 * Upkeep's status and the Attention page, and runs its `notify` command for
 * each item it hasn't seen, pointing at the item's dashboard page. Nothing is
 * said for green runs, and the first read after a start only records what's
 * there, so a restart doesn't repeat old notifications.
 */
import { Client, Domain } from "@upkeep/api";
import { Config, Effect, Option, Ref } from "effect";
import { reason } from "./Failure";
import { run } from "./jobs/bump";
import * as Settings from "./settings";

/** Something to tell you about: who it is, what it says and its page. */
export interface Told {
  /** Its identity, so the same item isn't told twice. */
  readonly key: string;
  readonly title: string;
  /** Its dashboard page, relative to the dashboard. */
  readonly path: string;
}

/** What needs you on the status, to tell. */
export const fromStatus = (item: Domain.NeedsYou): Told => ({
  key: `${item.kind}:${item.path}:${item.title}`,
  title: item.title,
  path: item.path,
});

/** The signals that put an item in Needs you, as its notification says them. */
const why = new Set<Domain.SignalKind>([
  "review-requested",
  "changes-requested",
  "unresolved",
  "new-comment",
  "mentioned",
  "ready",
]);

/**
 * The Attention page's Needs you items, to tell. Hidden items wait until they
 * change, and work items are left out while it isn't work time, as the
 * worker last said, but still count as seen, so they don't all arrive at once
 * when work starts; the Attention page has them then.
 */
export const fromAttention = (page: Domain.Attention) => {
  const needs = page.items.filter(
    (item) => item.section === "needs-you" && !item.hidden,
  );

  return {
    seen: needs.map((item) => `attention:${item.url}`),
    tell: needs
      .filter((item) => !(item.work && page.workTime === false))
      .map((item): Told => {
        const signals = item.signals
          .filter((signal) => why.has(signal.kind))
          .map((signal) => Domain.signalLabel(signal.kind));

        const reasons = signals.length > 0 ? signals : ["needs decision"];
        const number = item.number === null ? "" : `#${item.number}`;

        return {
          key: `attention:${item.url}`,
          title: `${item.repo}${number}: ${item.title} (${reasons.join(", ")})`,
          path: "attention",
        };
      }),
  };
};

/** The items in `now` that weren't in `before`. */
export const fresh = (before: ReadonlySet<string>, now: ReadonlyArray<Told>) =>
  now.filter((item) => !before.has(item.key));

/** A command's arguments with `{title}` and `{url}` filled in. */
export const fill = (
  command: ReadonlyArray<string>,
  item: Told,
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

  const statusSeen = yield* Ref.make<Option.Option<ReadonlySet<string>>>(
    Option.none(),
  );

  const attentionSeen = yield* Ref.make<Option.Option<ReadonlySet<string>>>(
    Option.none(),
  );

  /** What's new since the last read of one source, recording what's there. */
  const since = Effect.fnUntraced(function* (
    seen: Ref.Ref<Option.Option<ReadonlySet<string>>>,
    keys: ReadonlyArray<string>,
    tell: ReadonlyArray<Told>,
  ) {
    const before = yield* Ref.getAndSet(seen, Option.some(new Set(keys)));

    return Option.match(before, {
      onNone: (): ReadonlyArray<Told> => [],
      onSome: (value) => fresh(value, tell),
    });
  });

  const fromStatusNow = client.work.status().pipe(
    Effect.flatMap((status) => {
      const told = status.needs.map(fromStatus);

      return since(
        statusSeen,
        told.map((item) => item.key),
        told,
      );
    }),
    Effect.catchCause((cause) =>
      Effect.logDebug("Couldn't check what needs you", cause).pipe(
        Effect.as([]),
      ),
    ),
  );

  // A server older than the Attention page, or one with nothing collected
  // yet, leaves this quiet without stopping the status's notifications
  const fromAttentionNow = client.work.attentionPage().pipe(
    Effect.flatMap((page) => {
      const { seen, tell } = fromAttention(page);

      return since(attentionSeen, seen, tell);
    }),
    Effect.catchCause((cause) =>
      Effect.logDebug("Couldn't check the Attention page", cause).pipe(
        Effect.as([]),
      ),
    ),
  );

  return Effect.gen(function* () {
    const settings = yield* Settings.load();

    if (settings.notify === undefined) return;

    const notify = settings.notify;
    const told = [...(yield* fromStatusNow), ...(yield* fromAttentionNow)];

    if (told.length === 0) return;

    const dashboard =
      notify.dashboard ?? (yield* Config.String("UPKEEP_SERVER"));

    for (const item of told) {
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
