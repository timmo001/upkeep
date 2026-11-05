/**
 * GitHub responses kept between runs, by job: each GET is sent with the last
 * run's validators and answered from what was kept when GitHub says nothing
 * changed. A 304 costs no rate limit, so an unchanged read is free.
 */
import { Api } from "@timmo001/effect-gh";
import { Config, Effect, Exit, FileSystem, Path, Schema } from "effect";

const Entry = Schema.Struct({
  validators: Schema.Struct({
    etag: Schema.optionalKey(Schema.String),
    lastModified: Schema.optionalKey(Schema.String),
  }),
  value: Schema.Json,
});

type Entry = typeof Entry.Type;

const Entries = Schema.Record(Schema.String, Entry);

/** A GitHub GET: its endpoint and query. */
export interface Request {
  readonly endpoint: string;
  readonly query?: Readonly<Record<string, string | number>>;
}

/** What a kept GET read, and whether GitHub sent it anew. */
export interface Read {
  readonly value: Schema.Json;
  readonly changed: boolean;
}

export class KeptMissing extends Schema.TaggedError<KeptMissing>()(
  "KeptMissing",
  { endpoint: Schema.String },
) {
  override get message() {
    return `GitHub said ${this.endpoint} hadn't changed, with nothing kept`;
  }
}

const keyOf = ({ endpoint, query }: Request) => {
  const search = new URLSearchParams(
    Object.entries(query ?? {}).map(([name, value]) => [name, String(value)]),
  ).toString();

  return search === "" ? endpoint : `${endpoint}?${search}`;
};

const fileOf = (job: string) =>
  Config.String("XDG_CACHE_HOME").pipe(
    Config.orElse(() =>
      Config.String("HOME").pipe(Config.map((home) => `${home}/.cache`)),
    ),
    Config.map((root) => `${root}/upkeep/${job}/github.json`),
  );

/**
 * A job's kept responses, read now and written back when the scope closes.
 * Only what this run read is written, so what it no longer reads goes. With
 * `onlyOnSuccess`, a run that fails writes nothing, for a job that skips work
 * on what's unchanged and must not skip what the failed run left undone.
 */
export const make = Effect.fnUntraced(function* (
  job: string,
  options: { readonly onlyOnSuccess?: boolean } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* fileOf(job);

  const earlier = yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Entries))),
    Effect.orElseSucceed((): typeof Entries.Type => ({})),
  );

  const kept = new Map<string, Entry>();

  yield* Effect.addFinalizer((exit) =>
    options.onlyOnSuccess === true && Exit.isFailure(exit)
      ? Effect.void
      : fs
          .makeDirectory(path.dirname(file), { recursive: true })
          .pipe(
            Effect.andThen(
              fs.writeFileString(
                `${file}.tmp`,
                JSON.stringify(Object.fromEntries(kept)),
              ),
            ),
            Effect.andThen(fs.rename(`${file}.tmp`, file)),
            Effect.ignore,
          ),
  );

  /**
   * A conditional GET. One that can never change, such as a commit by its
   * SHA, isn't asked again at all once it's kept.
   */
  const get = Effect.fnUntraced(function* (
    request: Request,
    options: { readonly immutable?: boolean } = {},
  ) {
    const key = keyOf(request);
    const previous = earlier[key];

    if (previous !== undefined && options.immutable === true) {
      kept.set(key, previous);

      return { value: previous.value, changed: false } satisfies Read;
    }

    const response = yield* Api.conditional(
      {
        endpoint: request.endpoint,
        ...(request.query !== undefined && { query: request.query }),
      },
      Schema.Json,
      previous?.validators,
    );

    const current = Api.Conditional.$match(response, {
      Modified: ({ validators, value }) => ({
        entry: { validators, value },
        changed: true,
      }),
      NotModified: () =>
        previous === undefined
          ? undefined
          : { entry: previous, changed: false },
    });

    if (current === undefined)
      return yield* new KeptMissing({ endpoint: request.endpoint });

    kept.set(key, current.entry);

    return {
      value: current.entry.value,
      changed: current.changed,
    } satisfies Read;
  });

  /**
   * Drop what was kept for a GET, so the next run reads it in full, such as
   * when what depends on it failed and must be tried again.
   */
  const forget = (request: Request) =>
    Effect.sync(() => {
      kept.delete(keyOf(request));
    });

  return { get, forget };
});

/** A job's kept responses, from {@link make}. */
export type Kept = Effect.Success<ReturnType<typeof make>>;
