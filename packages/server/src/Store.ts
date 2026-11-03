/**
 * The server's state in SQLite: runs and their logs, the latest release seen
 * of each repository, and the hashes of the tokens it's issued.
 */
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Api, Domain } from "@upkeep/api";
import {
  Array as Arr,
  Clock,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  String,
} from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient } from "effect/sql";

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  cause: Schema.Defect(),
}) {}

const migrations = SqliteMigrator.fromRecord({
  "0001_runs_releases_tokens": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        job TEXT NOT NULL,
        trigger TEXT NOT NULL,
        release_repo TEXT,
        release_tag TEXT,
        release_url TEXT,
        state TEXT NOT NULL,
        worker TEXT,
        queued_at INTEGER NOT NULL,
        started_at INTEGER,
        heartbeat_at INTEGER,
        finished_at INTEGER,
        error TEXT
      )
    `;

    yield* sql`CREATE INDEX runs_job ON runs (job, queued_at)`;
    yield* sql`CREATE INDEX runs_state ON runs (state, queued_at)`;

    yield* sql`
      CREATE TABLE log_lines (
        run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        at INTEGER NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      )
    `;

    yield* sql`
      CREATE TABLE releases (
        repo TEXT PRIMARY KEY,
        tag TEXT NOT NULL,
        url TEXT NOT NULL,
        seen_at INTEGER NOT NULL
      )
    `;

    yield* sql`
      CREATE TABLE tokens (
        scope TEXT NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (scope, name)
      )
    `;
  }),
});

const RunRow = Schema.Struct({
  id: Schema.String,
  job: Schema.String,
  trigger: Domain.Trigger,
  releaseRepo: Schema.NullOr(Schema.String),
  releaseTag: Schema.NullOr(Schema.String),
  releaseUrl: Schema.NullOr(Schema.String),
  state: Domain.RunState,
  worker: Schema.NullOr(Schema.String),
  queuedAt: Schema.Finite,
  startedAt: Schema.NullOr(Schema.Finite),
  finishedAt: Schema.NullOr(Schema.Finite),
  error: Schema.NullOr(Schema.String),
});

const decodeRuns = Schema.decodeUnknownEffect(Schema.Array(RunRow));

const toRun = ({
  releaseRepo,
  releaseTag,
  releaseUrl,
  ...row
}: typeof RunRow.Type): Domain.Run => ({
  ...row,
  release:
    releaseRepo === null || releaseTag === null
      ? null
      : { repo: releaseRepo, tag: releaseTag, url: releaseUrl ?? "" },
});

const decodeLog = Schema.decodeUnknownEffect(Schema.Array(Domain.LogLine));

const decodeTokens = Schema.decodeUnknownEffect(Schema.Array(Api.Token));

const decodeReleases = Schema.decodeUnknownEffect(Schema.Array(Domain.Release));

/** A run to queue, and what started it. */
export interface NewRun {
  readonly job: Domain.JobId;
  readonly trigger: Domain.Trigger;
  readonly release: Domain.Release | null;
}

export class Store extends Context.Service<
  Store,
  {
    /**
     * Queue a run, unless one of the same job for the same release is still
     * waiting, which is returned instead.
     */
    queueRun(run: NewRun): Effect.Effect<Domain.Run, StoreError>;
    runs(filter: {
      readonly job?: string | undefined;
      readonly state?: Domain.RunState | undefined;
      readonly limit: number;
    }): Effect.Effect<ReadonlyArray<Domain.Run>, StoreError>;
    run(id: string): Effect.Effect<Domain.Run, Api.RunNotFound | StoreError>;
    /** The latest run of each job that has one. */
    latestRuns(): Effect.Effect<ReadonlyMap<string, Domain.Run>, StoreError>;
    /** Take the oldest waiting run of one of these jobs for a worker. */
    claim(
      jobs: ReadonlyArray<string>,
      worker: string,
    ): Effect.Effect<Option.Option<Domain.Run>, StoreError>;
    heartbeat(
      id: string,
      worker: string,
    ): Effect.Effect<void, Api.RunNotFound | Api.RunNotClaimed | StoreError>;
    appendLog(
      id: string,
      worker: string,
      lines: ReadonlyArray<Domain.LogEntry>,
    ): Effect.Effect<void, Api.RunNotFound | Api.RunNotClaimed | StoreError>;
    finish(
      id: string,
      worker: string,
      outcome: Domain.Outcome,
      error: string | null,
    ): Effect.Effect<void, Api.RunNotFound | Api.RunNotClaimed | StoreError>;
    log(
      id: string,
      after: number,
      limit: number,
    ): Effect.Effect<
      ReadonlyArray<Domain.LogLine>,
      Api.RunNotFound | StoreError
    >;
    /** Fail every running run with no heartbeat since `before`. */
    failLost(
      before: number,
    ): Effect.Effect<ReadonlyArray<Domain.Run>, StoreError>;
    /**
     * Record the latest releases, returning those that changed. A repository
     * seen for the first time is only recorded.
     */
    recordReleases(
      releases: ReadonlyArray<Domain.Release>,
    ): Effect.Effect<ReadonlyArray<Domain.Release>, StoreError>;
    addToken(
      scope: Api.TokenScope,
      name: string,
      tokenHash: string,
    ): Effect.Effect<boolean, StoreError>;
    tokenName(
      scope: Api.TokenScope,
      tokenHash: string,
    ): Effect.Effect<Option.Option<string>, StoreError>;
    tokens(
      scope: Api.TokenScope,
    ): Effect.Effect<ReadonlyArray<Api.Token>, StoreError>;
    removeToken(
      scope: Api.TokenScope,
      name: string,
    ): Effect.Effect<boolean, StoreError>;
  }
>()("@upkeep/server/Store") {
  static readonly make = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const random = yield* SecureRandom.SecureRandom;

    const storeError = (cause: unknown) => new StoreError({ cause });

    const selectRuns = Effect.fnUntraced(function* (
      statement: Effect.Effect<ReadonlyArray<unknown>, unknown>,
    ) {
      const rows = yield* statement.pipe(Effect.flatMap(decodeRuns));

      return rows.map(toRun);
    });

    const queueRun = Effect.fn("Store.queueRun")(
      function* ({ job, trigger, release }: NewRun) {
        const waiting = yield* selectRuns(sql`
          SELECT * FROM runs
          WHERE job = ${job}
            AND state = 'queued'
            AND coalesce(release_repo, '') = ${release?.repo ?? ""}
            AND coalesce(release_tag, '') = ${release?.tag ?? ""}
          LIMIT 1
        `);

        if (waiting[0] !== undefined) return waiting[0];

        const [created] = yield* selectRuns(sql`
          INSERT INTO runs ${sql.insert({
            id: yield* random.ulid,
            job,
            trigger,
            releaseRepo: release?.repo ?? null,
            releaseTag: release?.tag ?? null,
            releaseUrl: release?.url ?? null,
            state: "queued",
            queuedAt: yield* Clock.currentTimeMillis,
          })}
          RETURNING *
        `);

        if (created === undefined) {
          return yield* Effect.die(new Error("The new run wasn't returned"));
        }

        return created;
      },
      sql.withTransaction,
      Effect.mapError(storeError),
    );

    const runs = Effect.fn("Store.runs")(function* (filter: {
      readonly job?: string | undefined;
      readonly state?: Domain.RunState | undefined;
      readonly limit: number;
    }) {
      const conditions = [
        ...(filter.job === undefined ? [] : [sql`job = ${filter.job}`]),
        ...(filter.state === undefined ? [] : [sql`state = ${filter.state}`]),
      ];

      return yield* selectRuns(sql`
          SELECT * FROM runs
          ${conditions.length === 0 ? sql`` : sql`WHERE ${sql.and(conditions)}`}
          ORDER BY queued_at DESC, id DESC
          LIMIT ${filter.limit}
        `);
    }, Effect.mapError(storeError));

    const findRun = (id: string) =>
      selectRuns(sql`SELECT * FROM runs WHERE id = ${id}`).pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(storeError),
      );

    const run = Effect.fn("Store.run")(function* (id: string) {
      const found = yield* findRun(id);

      if (Option.isNone(found)) return yield* new Api.RunNotFound({ id });

      return found.value;
    });

    const latestRuns = Effect.fn("Store.latestRuns")(function* () {
      const rows = yield* selectRuns(sql`
          SELECT * FROM runs AS r
          WHERE id = (
            SELECT id FROM runs WHERE job = r.job
            ORDER BY queued_at DESC, id DESC LIMIT 1
          )
        `);

      return new Map(rows.map((row) => [row.job, row]));
    }, Effect.mapError(storeError));

    const claim = Effect.fn("Store.claim")(
      function* (jobs: ReadonlyArray<string>, worker: string) {
        if (jobs.length === 0) return Option.none();

        const now = yield* Clock.currentTimeMillis;

        const rows = yield* selectRuns(sql`
          UPDATE runs
          SET state = 'running', worker = ${worker}, started_at = ${now},
            heartbeat_at = ${now}
          WHERE id = (
            SELECT id FROM runs
            WHERE state = 'queued' AND ${sql.in("job", jobs)}
            ORDER BY queued_at, id LIMIT 1
          )
          RETURNING *
        `);

        return Option.fromNullishOr(rows[0]);
      },
      sql.withTransaction,
      Effect.mapError(storeError),
    );

    /** Check the run is running on this worker before it reports on it. */
    const claimed = Effect.fnUntraced(function* (id: string, worker: string) {
      const found = yield* run(id);

      if (found.state !== "running" || found.worker !== worker) {
        return yield* new Api.RunNotClaimed({ id, worker });
      }
    });

    const heartbeat = Effect.fn("Store.heartbeat")(function* (
      id: string,
      worker: string,
    ) {
      yield* claimed(id, worker);

      yield* sql`
        UPDATE runs SET heartbeat_at = ${yield* Clock.currentTimeMillis}
        WHERE id = ${id}
      `.pipe(Effect.mapError(storeError));
    });

    const appendLog = Effect.fn("Store.appendLog")(
      function* (
        id: string,
        worker: string,
        lines: ReadonlyArray<Domain.LogEntry>,
      ) {
        yield* claimed(id, worker);

        if (!Arr.isReadonlyArrayNonEmpty(lines)) return;

        const last = yield* sql<{ seq: number | null }>`
          SELECT max(seq) AS seq FROM log_lines WHERE run_id = ${id}
        `.pipe(Effect.mapError(storeError));

        const first = (last[0]?.seq ?? 0) + 1;

        yield* sql`
          INSERT INTO log_lines ${sql.insert(
            Arr.map(lines, (line, index) => ({
              runId: id,
              seq: first + index,
              at: line.at,
              level: line.level,
              message: line.message,
            })),
          )}
        `.pipe(Effect.mapError(storeError));

        yield* sql`
          UPDATE runs SET heartbeat_at = ${yield* Clock.currentTimeMillis}
          WHERE id = ${id}
        `.pipe(Effect.mapError(storeError));
      },
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(storeError(cause))),
    );

    const finish = Effect.fn("Store.finish")(
      function* (
        id: string,
        worker: string,
        outcome: Domain.Outcome,
        error: string | null,
      ) {
        yield* claimed(id, worker);

        yield* sql`
          UPDATE runs
          SET state = ${outcome}, finished_at = ${yield* Clock.currentTimeMillis},
            error = ${error}
          WHERE id = ${id}
        `.pipe(Effect.mapError(storeError));
      },
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(storeError(cause))),
    );

    const log = Effect.fn("Store.log")(function* (
      id: string,
      after: number,
      limit: number,
    ) {
      yield* run(id);

      return yield* sql`
        SELECT seq, at, level, message FROM log_lines
        WHERE run_id = ${id} AND seq > ${after}
        ORDER BY seq LIMIT ${limit}
      `.pipe(Effect.flatMap(decodeLog), Effect.mapError(storeError));
    });

    const failLost = Effect.fn("Store.failLost")(function* (before: number) {
      return yield* selectRuns(sql`
          UPDATE runs
          SET state = 'failed', finished_at = ${yield* Clock.currentTimeMillis},
            error = 'Lost: the worker stopped sending heartbeats'
          WHERE state = 'running' AND heartbeat_at < ${before}
          RETURNING *
        `);
    }, Effect.mapError(storeError));

    const recordReleases = Effect.fn("Store.recordReleases")(
      function* (releases: ReadonlyArray<Domain.Release>) {
        const now = yield* Clock.currentTimeMillis;
        const changed: Array<Domain.Release> = [];

        for (const release of releases) {
          const known = yield* sql`
            SELECT repo, tag, url FROM releases WHERE repo = ${release.repo}
          `.pipe(Effect.flatMap(decodeReleases));

          const previous = known[0];

          if (previous?.tag === release.tag) continue;

          yield* sql`
            INSERT INTO releases ${sql.insert({
              repo: release.repo,
              tag: release.tag,
              url: release.url,
              seenAt: now,
            })}
            ON CONFLICT (repo) DO UPDATE
            SET tag = excluded.tag, url = excluded.url, seen_at = excluded.seen_at
          `;

          if (previous !== undefined) changed.push(release);
        }

        return changed;
      },
      sql.withTransaction,
      Effect.mapError(storeError),
    );

    const addToken = Effect.fn("Store.addToken")(function* (
      scope: Api.TokenScope,
      name: string,
      tokenHash: string,
    ) {
      const rows = yield* sql`
          INSERT INTO tokens ${sql.insert({
            scope,
            name,
            tokenHash,
            createdAt: yield* Clock.currentTimeMillis,
          })}
          ON CONFLICT DO NOTHING
          RETURNING name
        `;

      return rows.length > 0;
    }, Effect.mapError(storeError));

    const tokenName = Effect.fn("Store.tokenName")(function* (
      scope: Api.TokenScope,
      tokenHash: string,
    ) {
      const rows = yield* sql<{ name: string }>`
          SELECT name FROM tokens
          WHERE scope = ${scope} AND token_hash = ${tokenHash}
        `;

      return Option.fromNullishOr(rows[0]?.name);
    }, Effect.mapError(storeError));

    const tokens = Effect.fn("Store.tokens")(function* (scope: Api.TokenScope) {
      return yield* sql`
          SELECT name, created_at FROM tokens
          WHERE scope = ${scope} ORDER BY created_at
        `.pipe(Effect.flatMap(decodeTokens));
    }, Effect.mapError(storeError));

    const removeToken = Effect.fn("Store.removeToken")(function* (
      scope: Api.TokenScope,
      name: string,
    ) {
      const rows = yield* sql`
          DELETE FROM tokens WHERE scope = ${scope} AND name = ${name}
          RETURNING name
        `;

      return rows.length > 0;
    }, Effect.mapError(storeError));

    return Store.of({
      queueRun,
      runs,
      run,
      latestRuns,
      claim,
      heartbeat,
      appendLog,
      finish,
      log,
      failLost,
      recordReleases,
      addToken,
      tokenName,
      tokens,
      removeToken,
    });
  });

  /** A store in the given SQLite database file, migrated before use. */
  static readonly layerFile = (filename: string) =>
    Layer.effect(Store, Store.make).pipe(
      Layer.provide(SqliteMigrator.layer({ loader: migrations })),
      Layer.provide(
        SqliteClient.layer({
          filename,
          transformQueryNames: String.camelToSnake,
          transformResultNames: String.snakeToCamel,
        }),
      ),
      Layer.provide(SecureRandom.layerWebCrypto),
    );

  /**
   * The store at `$UPKEEP_SERVER_DB`, or `server.db` in
   * `$XDG_STATE_HOME/upkeep`, creating its directory when needed.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* Config.String("HOME").pipe(Config.withDefault(""));

      const stateHome = yield* Config.String("XDG_STATE_HOME").pipe(
        Config.withDefault(path.join(home, ".local", "state")),
      );

      const filename = yield* Config.String("UPKEEP_SERVER_DB").pipe(
        Config.withDefault(path.join(stateHome, "upkeep", "server.db")),
      );

      yield* fs.makeDirectory(path.dirname(filename), { recursive: true });

      return Store.layerFile(filename);
    }),
  );
}
