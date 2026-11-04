/**
 * The server's state in SQLite: runs and their logs, the latest release seen
 * of each repository, the repositories it tracks, the inbox of what changed,
 * and the hashes of the tokens it's issued.
 */
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Api, Catalogue, Domain } from "@upkeep/api";
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
import * as Entries from "./Entries";

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
  "0002_heals_parked": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    for (const column of [
      "heal_of",
      "heal_job",
      "heal_target",
      "heal_decision",
      "heal_reason",
      "heal_model",
      "heal_variant",
      "heal_actions",
      "heal_commit",
      "heal_session",
    ]) {
      yield* sql`ALTER TABLE runs ADD COLUMN ${sql(column)} TEXT`;
    }

    yield* sql`CREATE INDEX runs_heal_job ON runs (heal_job, queued_at)`;

    yield* sql`
      CREATE TABLE parked (
        job TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        parked_at INTEGER NOT NULL
      )
    `;
  }),
  "0003_triage_issues": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`ALTER TABLE runs ADD COLUMN heal_issue TEXT`;
    yield* sql`ALTER TABLE parked ADD COLUMN issue TEXT`;
  }),
  "0004_tracked_repos": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE repos (
        repo TEXT PRIMARY KEY COLLATE NOCASE,
        jobs TEXT NOT NULL,
        added_at INTEGER NOT NULL
      )
    `;
  }),
  "0005_requeued_runs": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`ALTER TABLE runs ADD COLUMN requeued INTEGER NOT NULL DEFAULT 0`;
  }),
  "0006_run_reports": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`ALTER TABLE runs ADD COLUMN summary TEXT`;
    yield* sql`ALTER TABLE runs ADD COLUMN changes TEXT NOT NULL DEFAULT '[]'`;
    yield* sql`ALTER TABLE runs ADD COLUMN attention INTEGER NOT NULL DEFAULT 0`;
  }),
  "0007_paused": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE paused (
        job TEXT PRIMARY KEY,
        paused_at INTEGER NOT NULL,
        paused_by TEXT NOT NULL
      )
    `;
  }),
  "0008_inbox": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        url TEXT,
        job TEXT,
        run TEXT,
        routine INTEGER NOT NULL,
        you INTEGER NOT NULL,
        count INTEGER NOT NULL,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        read_at INTEGER,
        dismissed_at INTEGER
      )
    `;

    yield* sql`CREATE INDEX entries_last_at ON entries (last_at)`;

    yield* sql`
      CREATE TABLE entry_items (
        entry_id TEXT NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
        repo TEXT NOT NULL COLLATE NOCASE,
        sha TEXT,
        text TEXT NOT NULL,
        url TEXT,
        at INTEGER NOT NULL
      )
    `;

    yield* sql`CREATE INDEX entry_items_entry ON entry_items (entry_id, at)`;
    yield* sql`
      CREATE UNIQUE INDEX entry_items_commit ON entry_items (repo, sha)
      WHERE sha IS NOT NULL
    `;
  }),
  // The first watch runs marked bots' and lockfile-only commits worth reading,
  // and the watch job skips commits the inbox has, so start it again.
  "0009_inbox_refill": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`DELETE FROM entry_items`;
    yield* sql`DELETE FROM entries`;
  }),
  "0010_repo_titles": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`ALTER TABLE repos ADD COLUMN title TEXT`;
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
  healOf: Schema.NullOr(Schema.String),
  healJob: Schema.NullOr(Schema.String),
  healTarget: Schema.NullOr(Schema.String),
  healDecision: Schema.NullOr(Domain.HealDecision),
  healReason: Schema.NullOr(Schema.String),
  healModel: Schema.NullOr(Schema.String),
  healVariant: Schema.NullOr(Schema.String),
  healActions: Schema.NullOr(
    Schema.fromJsonString(Schema.Array(Schema.String)),
  ),
  healCommit: Schema.NullOr(Schema.String),
  healSession: Schema.NullOr(Schema.String),
  healIssue: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  changes: Schema.fromJsonString(Schema.Array(Domain.Change)),
  attention: Schema.Number,
});

const decodeRuns = Schema.decodeUnknownEffect(Schema.Array(RunRow));

/** A heal's target as it's kept: `upkeep`, or the consumer's `owner/name`. */
const targetColumn = (target: Domain.Target) =>
  target.kind === "upkeep" ? "upkeep" : target.repo;

const targetOf = (column: string): Domain.Target =>
  column === "upkeep" ? { kind: "upkeep" } : { kind: "consumer", repo: column };

const toRun = ({
  releaseRepo,
  releaseTag,
  releaseUrl,
  healOf,
  healJob,
  healTarget,
  healDecision,
  healReason,
  healModel,
  healVariant,
  healActions,
  healCommit,
  healSession,
  healIssue,
  attention,
  ...row
}: typeof RunRow.Type): Domain.Run => ({
  ...row,
  attention: attention !== 0,
  release:
    releaseRepo === null || releaseTag === null
      ? null
      : { repo: releaseRepo, tag: releaseTag, url: releaseUrl ?? "" },
  heal:
    healOf === null || healJob === null || healTarget === null
      ? null
      : {
          of: healOf,
          job: healJob,
          target: targetOf(healTarget),
          decision: healDecision,
          reason: healReason,
          model: healModel,
          variant: healVariant,
          actions: healActions ?? [],
          commit: healCommit,
          session: healSession,
          issue: healIssue,
        },
});

const decodeLog = Schema.decodeUnknownEffect(Schema.Array(Domain.LogLine));

const decodeTokens = Schema.decodeUnknownEffect(Schema.Array(Api.Token));

const decodeReleases = Schema.decodeUnknownEffect(Schema.Array(Domain.Release));

const decodeParked = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ job: Schema.String, ...Domain.Parked.fields })),
);

const decodePaused = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ job: Schema.String, ...Domain.Paused.fields })),
);

const EntryRow = Schema.Struct({
  ...Domain.Entry.fields,
  routine: Schema.Number,
  you: Schema.Number,
  items: Schema.optionalKey(Schema.Unknown),
});

const decodeEntries = Schema.decodeUnknownEffect(Schema.Array(EntryRow));

const ItemRow = Schema.Struct({
  entryId: Schema.String,
  ...Domain.EntryItem.fields,
});

const decodeItems = Schema.decodeUnknownEffect(Schema.Array(ItemRow));

/** How far back the inbox is filled from runs the first time it starts. */
const backfillHours = 48;

const jobName = (id: string) =>
  Catalogue.jobs.find((job) => job.id === id)?.name ?? id;

/** The entry of a parked job. */
const parkedKey = (job: string) => `needs:parked:${job}`;

/** An entry for something that needs a person, by its key. */
export interface Needs {
  readonly key: string;
  readonly title: string;
  readonly detail: string | null;
  readonly job: string | null;
  readonly run: string | null;
}

const decodeRepos = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      ...Domain.TrackedRepo.fields,
      jobs: Schema.fromJsonString(Domain.TrackedRepo.fields.jobs),
    }),
  ),
);

/** A run to queue, and what started it. */
export interface NewRun {
  readonly job: Domain.JobId;
  readonly trigger: Domain.Trigger;
  readonly release: Domain.Release | null;
  /** For a heal: the failed run, its job, what to heal and its triage issue. */
  readonly heal?: {
    readonly of: string;
    readonly job: Domain.JobId;
    readonly target: Domain.Target;
    readonly issue?: string | null;
  };
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
    /** End a run, returning it as it ended. */
    finish(
      id: string,
      worker: string,
      outcome: Domain.Outcome,
      error: string | null,
    ): Effect.Effect<
      Domain.Run,
      Api.RunNotFound | Api.RunNotClaimed | StoreError
    >;
    /** Fill in a heal's record from the worker running it. */
    updateHeal(
      id: string,
      worker: string,
      update: Api.HealUpdate,
    ): Effect.Effect<void, Api.RunNotFound | Api.RunNotClaimed | StoreError>;
    /** Record a run's summary, a commit it pushed, or that it needs a person. */
    report(
      id: string,
      worker: string,
      report: Api.RunReport,
    ): Effect.Effect<void, Api.RunNotFound | Api.RunNotClaimed | StoreError>;
    /** What happened since `since`. */
    activity(since: number): Effect.Effect<Domain.Activity, StoreError>;
    /** How many heals of a job's runs, for one target, were queued since `since`. */
    healsSince(
      job: string,
      target: Domain.Target,
      since: number,
    ): Effect.Effect<number, StoreError>;
    /** Every heal queued since `since`, newest first. */
    heals(since: number): Effect.Effect<ReadonlyArray<Domain.Run>, StoreError>;
    /**
     * Park a job, replacing the reason and issue when it's already parked.
     * `issue` is its triage issue, which unparks it once resolved.
     */
    park(
      job: string,
      reason: string,
      issue: string | null,
    ): Effect.Effect<void, StoreError>;
    /** Unpark a job, returning whether it was parked. */
    unpark(job: string): Effect.Effect<boolean, StoreError>;
    /** The parked jobs, by job ID. */
    parked(): Effect.Effect<ReadonlyMap<string, Domain.Parked>, StoreError>;
    /** Pause a job, keeping when and by whom when it's already paused. */
    pause(job: string, by: string): Effect.Effect<void, StoreError>;
    /** Resume a paused job, returning whether it was paused. */
    resume(job: string): Effect.Effect<boolean, StoreError>;
    /** The paused jobs, by job ID. */
    paused(): Effect.Effect<ReadonlyMap<string, Domain.Paused>, StoreError>;
    /**
     * Drop a queued run, or mark a running one cancelled so its worker stops
     * at its next heartbeat. `by` is who cancelled it, for the run's error.
     */
    cancel(
      id: string,
      by: string,
    ): Effect.Effect<
      Api.Cancelled,
      Api.RunNotFound | Api.RunFinished | StoreError
    >;
    log(
      id: string,
      after: number,
      limit: number,
    ): Effect.Effect<
      ReadonlyArray<Domain.LogLine>,
      Api.RunNotFound | StoreError
    >;
    /** A run's last `limit` log lines, oldest first. */
    logTail(
      id: string,
      limit: number,
    ): Effect.Effect<
      ReadonlyArray<Domain.LogLine>,
      Api.RunNotFound | StoreError
    >;
    /** Check a run is running on this worker. */
    claimed(
      id: string,
      worker: string,
    ): Effect.Effect<void, Api.RunNotFound | Api.RunNotClaimed | StoreError>;
    /**
     * Delete finished runs queued before `before` and their logs, keeping the
     * latest `keep` of each job. Returns how many runs went.
     */
    prune(before: number, keep: number): Effect.Effect<number, StoreError>;
    /**
     * Put a run its worker was stopped in back in the queue, the first time
     * that happens to it. Returns it requeued, or none when it's been cut
     * off before, so a run that brings its worker down can't loop.
     */
    requeue(
      id: string,
      worker: string,
    ): Effect.Effect<
      Option.Option<Domain.Run>,
      Api.RunNotFound | Api.RunNotClaimed | StoreError
    >;
    /**
     * Deal with every running run with no heartbeat since `before`: requeue
     * it the first time, as for `requeue`, and fail it after that.
     */
    failLost(before: number): Effect.Effect<
      {
        readonly requeued: ReadonlyArray<Domain.Run>;
        readonly failed: ReadonlyArray<Domain.Run>;
      },
      StoreError
    >;
    /**
     * Record the latest releases, returning those that changed. A repository
     * seen for the first time is only recorded.
     */
    recordReleases(
      releases: ReadonlyArray<Domain.Release>,
    ): Effect.Effect<ReadonlyArray<Domain.Release>, StoreError>;
    /**
     * The inbox: entries unread or changed since `since`, newest first,
     * leaving out dismissed ones.
     */
    inbox(since: number): Effect.Effect<Domain.Inbox, StoreError>;
    /** Mark entries read, or every unread one when `ids` is undefined. */
    markRead(
      ids: ReadonlyArray<string> | undefined,
    ): Effect.Effect<void, StoreError>;
    /** Dismiss an entry until something new joins it. */
    dismiss(
      id: string,
    ): Effect.Effect<Domain.Entry, Api.EntryNotFound | StoreError>;
    /** Which of these commits are already in the inbox. */
    known(
      commits: ReadonlyArray<Api.CommitRef>,
    ): Effect.Effect<ReadonlyArray<Api.CommitRef>, StoreError>;
    /**
     * Add commits found outside Upkeep's runs to the inbox, skipping ones it
     * has. Returns how many were added.
     */
    seen(
      commits: ReadonlyArray<Domain.Change>,
    ): Effect.Effect<number, StoreError>;
    /** Raise or update an entry that needs a person. */
    needs(needs: Needs): Effect.Effect<void, StoreError>;
    /** Settle an entry that needed a person, so it leaves the inbox. */
    settle(key: string): Effect.Effect<void, StoreError>;
    /** Delete read or dismissed entries last changed before `before`. */
    pruneInbox(before: number): Effect.Effect<number, StoreError>;
    /** Every tracked repository, by name. */
    repos(): Effect.Effect<ReadonlyArray<Domain.TrackedRepo>, StoreError>;
    /**
     * Track a repository with the jobs it's opted into, replacing them when
     * it's already tracked. Names are matched ignoring case.
     */
    track(
      repo: string,
      jobs: ReadonlyArray<string>,
    ): Effect.Effect<Domain.TrackedRepo, StoreError>;
    /** Stop tracking a repository, returning whether it was tracked. */
    untrack(repo: string): Effect.Effect<boolean, StoreError>;
    /** Record tracked repositories' titles, as their READMEs give them. */
    setTitles(
      titles: ReadonlyArray<Api.RepoTitle>,
    ): Effect.Effect<void, StoreError>;
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
      function* ({ job, trigger, release, heal }: NewRun) {
        const waiting = yield* selectRuns(sql`
          SELECT * FROM runs
          WHERE job = ${job}
            AND state = 'queued'
            AND coalesce(release_repo, '') = ${release?.repo ?? ""}
            AND coalesce(release_tag, '') = ${release?.tag ?? ""}
            AND coalesce(heal_of, '') = ${heal?.of ?? ""}
            AND coalesce(heal_target, '') = ${heal === undefined ? "" : targetColumn(heal.target)}
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
            healOf: heal?.of ?? null,
            healJob: heal?.job ?? null,
            healTarget: heal === undefined ? null : targetColumn(heal.target),
            healActions: heal === undefined ? null : "[]",
            healIssue: heal?.issue ?? null,
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
              AND (trigger = 'manual'
                OR job NOT IN (SELECT job FROM paused))
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

        const [ended] = yield* selectRuns(sql`
          UPDATE runs
          SET state = ${outcome}, finished_at = ${yield* Clock.currentTimeMillis},
            error = ${error}
          WHERE id = ${id}
          RETURNING *
        `).pipe(Effect.mapError(storeError));

        if (ended === undefined) {
          return yield* Effect.die(
            new Error("The finished run wasn't returned"),
          );
        }

        return ended;
      },
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(storeError(cause))),
    );

    const updateHeal = Effect.fn("Store.updateHeal")(
      function* (id: string, worker: string, update: Api.HealUpdate) {
        yield* claimed(id, worker);

        const current = yield* run(id);

        if (current.heal === null) return;

        const actions =
          update.action === undefined
            ? current.heal.actions
            : [...current.heal.actions, update.action];

        yield* sql`
          UPDATE runs SET ${sql.update({
            healDecision: update.decision ?? current.heal.decision,
            healReason: update.reason ?? current.heal.reason,
            healModel: update.model ?? current.heal.model,
            healVariant: update.variant ?? current.heal.variant,
            healActions: JSON.stringify(actions),
            healCommit: update.commit ?? current.heal.commit,
            healSession: update.session ?? current.heal.session,
          })}
          WHERE id = ${id}
        `.pipe(Effect.mapError(storeError));
      },
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(storeError(cause))),
    );

    const report = Effect.fn("Store.report")(
      function* (id: string, worker: string, update: Api.RunReport) {
        yield* claimed(id, worker);

        const current = yield* run(id);

        yield* sql`
          UPDATE runs SET ${sql.update({
            summary: update.summary ?? current.summary,
            changes: JSON.stringify(
              update.change === undefined
                ? current.changes
                : [...current.changes, update.change],
            ),
            attention: (update.attention ?? current.attention) ? 1 : 0,
          })}
          WHERE id = ${id}
        `.pipe(Effect.mapError(storeError));

        if (update.change !== undefined) {
          yield* placeChange(update.change, current).pipe(
            Effect.mapError(storeError),
          );
        }

        // A heal that leaves something for a person needs them, unless it
        // parked the job, which raises its own entry.
        const healing = current.heal;

        if (
          update.attention === true &&
          healing !== null &&
          healing.decision !== "park"
        ) {
          const job = jobName(healing.job);

          yield* needs({
            key: `needs:heal:${healing.job}:${healing.decision ?? "ask"}`,
            title:
              healing.decision === "fix"
                ? `A fix for ${job} needs you`
                : `Heal asks you about ${job}`,
            detail: update.summary ?? current.summary,
            job: healing.job,
            run: id,
          });
        }
      },
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(storeError(cause))),
    );

    const activity = Effect.fn("Store.activity")(function* (since: number) {
      const counts = yield* sql<{
        state: string;
        heals: number;
        count: number;
      }>`
        SELECT state, heal_of IS NOT NULL AS heals, count(*) AS count FROM runs
        WHERE queued_at >= ${since}
        GROUP BY state, heal_of IS NOT NULL
      `;

      const total = (state: string) =>
        counts
          .filter((row) => row.state === state)
          .reduce((sum, row) => sum + row.count, 0);

      const changed = yield* selectRuns(sql`
        SELECT * FROM runs
        WHERE queued_at >= ${since} AND changes != '[]'
        ORDER BY queued_at DESC, id DESC
      `);

      const attention = yield* selectRuns(sql`
        SELECT * FROM runs
        WHERE queued_at >= ${since} AND attention = 1
        ORDER BY queued_at DESC, id DESC
      `);

      return {
        since,
        runs: {
          succeeded: total("succeeded"),
          skipped: total("skipped"),
          failed: total("failed"),
          cancelled: total("cancelled"),
          heals: counts
            .filter((row) => row.heals !== 0)
            .reduce((sum, row) => sum + row.count, 0),
        },
        changes: changed
          .flatMap((item) =>
            item.changes.map((change) => ({
              ...change,
              run: item.id,
              job: item.job,
            })),
          )
          .toSorted((a, b) => b.at - a.at),
        attention,
      };
    }, Effect.mapError(storeError));

    const healsSince = Effect.fn("Store.healsSince")(function* (
      job: string,
      target: Domain.Target,
      since: number,
    ) {
      const rows = yield* sql<{ count: number }>`
        SELECT count(*) AS count FROM runs
        WHERE heal_job = ${job} AND heal_target = ${targetColumn(target)}
          AND queued_at >= ${since}
      `;

      return rows[0]?.count ?? 0;
    }, Effect.mapError(storeError));

    const heals = Effect.fn("Store.heals")(function* (since: number) {
      return yield* selectRuns(sql`
        SELECT * FROM runs
        WHERE heal_of IS NOT NULL AND queued_at >= ${since}
        ORDER BY queued_at DESC, id DESC
      `);
    }, Effect.mapError(storeError));

    const park = Effect.fn("Store.park")(function* (
      job: string,
      reason: string,
      issue: string | null,
    ) {
      yield* sql`
        INSERT INTO parked ${sql.insert({
          job,
          reason,
          parkedAt: yield* Clock.currentTimeMillis,
          issue,
        })}
        ON CONFLICT (job) DO UPDATE
        SET reason = excluded.reason, parked_at = excluded.parked_at,
          issue = excluded.issue
      `;

      yield* needs({
        key: parkedKey(job),
        title: `${jobName(job)} is parked`,
        detail: reason,
        job,
        run: null,
      });
    }, Effect.mapError(storeError));

    const unpark = Effect.fn("Store.unpark")(function* (job: string) {
      const rows = yield* sql`
        DELETE FROM parked WHERE job = ${job} RETURNING job
      `;

      yield* settle(parkedKey(job));

      return rows.length > 0;
    }, Effect.mapError(storeError));

    const parked = Effect.fn("Store.parked")(function* () {
      const rows = yield* sql`
        SELECT job, reason, parked_at AS at, issue FROM parked
      `.pipe(Effect.flatMap(decodeParked));

      return new Map(
        rows.map(({ job, ...entry }): [string, Domain.Parked] => [job, entry]),
      );
    }, Effect.mapError(storeError));

    const pause = Effect.fn("Store.pause")(function* (job: string, by: string) {
      yield* sql`
        INSERT INTO paused ${sql.insert({
          job,
          pausedAt: yield* Clock.currentTimeMillis,
          pausedBy: by,
        })}
        ON CONFLICT (job) DO NOTHING
      `;
    }, Effect.mapError(storeError));

    const resume = Effect.fn("Store.resume")(function* (job: string) {
      const rows = yield* sql`
        DELETE FROM paused WHERE job = ${job} RETURNING job
      `;

      return rows.length > 0;
    }, Effect.mapError(storeError));

    const paused = Effect.fn("Store.paused")(function* () {
      const rows = yield* sql`
        SELECT job, paused_at AS at, paused_by AS by FROM paused
      `.pipe(Effect.flatMap(decodePaused));

      return new Map(
        rows.map(({ job, ...entry }): [string, Domain.Paused] => [job, entry]),
      );
    }, Effect.mapError(storeError));

    const cancel = Effect.fn("Store.cancel")(
      function* (id: string, by: string) {
        const found = yield* run(id);

        if (found.state === "queued") {
          yield* sql`DELETE FROM runs WHERE id = ${id}`.pipe(
            Effect.mapError(storeError),
          );

          return { run: found, dropped: true };
        }

        if (found.state !== "running") {
          return yield* new Api.RunFinished({ id, state: found.state });
        }

        const [cancelled] = yield* selectRuns(sql`
          UPDATE runs
          SET state = 'cancelled',
            finished_at = ${yield* Clock.currentTimeMillis},
            error = ${`Cancelled by ${by}`}
          WHERE id = ${id}
          RETURNING *
        `).pipe(Effect.mapError(storeError));

        if (cancelled === undefined) {
          return yield* Effect.die(
            new Error("The cancelled run wasn't returned"),
          );
        }

        return { run: cancelled, dropped: false };
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

    const logTail = Effect.fn("Store.logTail")(function* (
      id: string,
      limit: number,
    ) {
      yield* run(id);

      return yield* sql`
        SELECT * FROM (
          SELECT seq, at, level, message FROM log_lines
          WHERE run_id = ${id}
          ORDER BY seq DESC LIMIT ${limit}
        ) ORDER BY seq
      `.pipe(Effect.flatMap(decodeLog), Effect.mapError(storeError));
    });

    const requeued = sql`
      state = 'queued', worker = NULL, started_at = NULL, heartbeat_at = NULL,
        requeued = requeued + 1
    `;

    const requeue = Effect.fn("Store.requeue")(
      function* (id: string, worker: string) {
        yield* claimed(id, worker);

        const rows = yield* selectRuns(sql`
          UPDATE runs SET ${requeued}
          WHERE id = ${id} AND requeued = 0
          RETURNING *
        `).pipe(Effect.mapError(storeError));

        return Option.fromNullishOr(rows[0]);
      },
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(storeError(cause))),
    );

    const failLost = Effect.fn("Store.failLost")(
      function* (before: number) {
        const failed = yield* selectRuns(sql`
          UPDATE runs
          SET state = 'failed', finished_at = ${yield* Clock.currentTimeMillis},
            error = 'Lost: the worker stopped sending heartbeats, again'
          WHERE state = 'running' AND heartbeat_at < ${before} AND requeued > 0
          RETURNING *
        `);

        const requeuedRuns = yield* selectRuns(sql`
          UPDATE runs SET ${requeued}
          WHERE state = 'running' AND heartbeat_at < ${before}
          RETURNING *
        `);

        return { requeued: requeuedRuns, failed };
      },
      sql.withTransaction,
      Effect.mapError(storeError),
    );

    const prune = Effect.fn("Store.prune")(
      function* (before: number, keep: number) {
        const doomed = sql`
          SELECT id FROM (
            SELECT id, queued_at, ROW_NUMBER() OVER (
              PARTITION BY job ORDER BY queued_at DESC, id DESC
            ) AS rank
            FROM runs
            WHERE state IN ('succeeded', 'skipped', 'failed', 'cancelled')
          )
          WHERE rank > ${keep} AND queued_at < ${before}
        `;

        yield* sql`DELETE FROM log_lines WHERE run_id IN (${doomed})`;

        const deleted = yield* sql<{ readonly id: string }>`
          DELETE FROM runs WHERE id IN (${doomed}) RETURNING id
        `;

        return deleted.length;
      },
      sql.withTransaction,
      Effect.mapError(storeError),
    );

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

          if (previous === undefined) continue;

          changed.push(release);

          yield* upsertEntry(
            {
              key: Entries.releaseKey(release),
              kind: "release",
              title: Entries.releaseTitle(release),
              detail: null,
              url: release.url,
              job: null,
              run: null,
              routine: false,
              you: false,
              at: now,
            },
            false,
          );
        }

        return changed;
      },
      sql.withTransaction,
      Effect.mapError(storeError),
    );

    /**
     * Add to an entry, or start it. Joining an existing entry brings it back
     * unread and undismissed; `replace` also takes the new title and detail,
     * for an entry that says what's happening now.
     */
    const upsertEntry = Effect.fnUntraced(function* (
      entry: {
        readonly key: string;
        readonly kind: Domain.EntryKind;
        readonly title: string;
        readonly detail: string | null;
        readonly url: string | null;
        readonly job: string | null;
        readonly run: string | null;
        readonly routine: boolean;
        readonly you: boolean;
        readonly at: number;
      },
      replace: boolean,
    ) {
      const rows = yield* sql<{ id: string }>`
        INSERT INTO entries ${sql.insert({
          id: yield* random.ulid,
          key: entry.key,
          kind: entry.kind,
          title: entry.title,
          detail: entry.detail,
          url: entry.url,
          job: entry.job,
          run: entry.run,
          routine: entry.routine ? 1 : 0,
          you: entry.you ? 1 : 0,
          count: 1,
          firstAt: entry.at,
          lastAt: entry.at,
        })}
        ON CONFLICT (key) DO UPDATE SET
          title = ${replace ? sql`excluded.title` : sql`entries.title`},
          detail = ${replace ? sql`excluded.detail` : sql`coalesce(entries.detail, excluded.detail)`},
          url = coalesce(entries.url, excluded.url),
          job = coalesce(excluded.job, entries.job),
          run = coalesce(excluded.run, entries.run),
          routine = entries.routine AND excluded.routine,
          you = entries.you OR excluded.you,
          count = entries.count + 1,
          last_at = max(entries.last_at, excluded.last_at),
          read_at = NULL,
          dismissed_at = NULL
        RETURNING id
      `;

      const id = rows[0]?.id;

      if (id === undefined) {
        return yield* Effect.die(new Error("The inbox entry wasn't returned"));
      }

      return id;
    });

    /**
     * Put a commit in the inbox. A run's own commit takes the place of the
     * same commit the watch job found first; one from the watch job is
     * skipped when the inbox has it. Returns whether it was added.
     */
    const placeChange = Effect.fnUntraced(function* (
      change: Domain.Change,
      from: Domain.Run | null,
    ) {
      const existing = yield* sql<{ entryId: string }>`
        SELECT entry_id FROM entry_items
        WHERE repo = ${change.repo} AND sha = ${change.sha}
      `;

      if (existing.length > 0) {
        if (from === null) return false;

        yield* sql`
          DELETE FROM entry_items WHERE repo = ${change.repo} AND sha = ${change.sha}
        `;
        yield* sql`
          DELETE FROM entries
          WHERE ${sql.in(
            "id",
            existing.map((row) => row.entryId),
          )}
            AND kind IN ('commit', 'update')
            AND NOT EXISTS (
              SELECT 1 FROM entry_items WHERE entry_id = entries.id
            )
        `;
      }

      const place = Entries.placement(change, from);

      const id = yield* upsertEntry(
        {
          key: place.key,
          kind: place.kind,
          title: place.title,
          detail: null,
          url: null,
          job: null,
          run: from?.id ?? null,
          routine: place.routine,
          you: place.you,
          at: change.at,
        },
        false,
      );

      yield* sql`
        INSERT INTO entry_items ${sql.insert({
          entryId: id,
          repo: change.repo,
          sha: change.sha,
          text: place.text,
          url: change.url,
          at: change.at,
        })}
      `;

      return true;
    });

    const needs = Effect.fn("Store.needs")(function* (raised: Needs) {
      yield* upsertEntry(
        {
          ...raised,
          kind: "needs",
          url: null,
          routine: false,
          you: false,
          at: yield* Clock.currentTimeMillis,
        },
        true,
      );
    }, Effect.mapError(storeError));

    const settle = Effect.fn("Store.settle")(function* (key: string) {
      yield* sql`
        UPDATE entries SET dismissed_at = ${yield* Clock.currentTimeMillis}
        WHERE key = ${key} AND dismissed_at IS NULL
      `;
    }, Effect.mapError(storeError));

    const selectEntries = Effect.fnUntraced(function* (
      statement: Effect.Effect<ReadonlyArray<unknown>, unknown>,
    ) {
      const rows = yield* statement.pipe(Effect.flatMap(decodeEntries));

      if (rows.length === 0) return [];

      const items = yield* sql`
        SELECT entry_id, repo, sha, text, url, at FROM entry_items
        WHERE ${sql.in(
          "entry_id",
          rows.map((row) => row.id),
        )}
        ORDER BY at, repo
      `.pipe(Effect.flatMap(decodeItems));

      const byEntry = Arr.groupBy(items, (item) => item.entryId);

      return rows.map(
        ({ routine, you, items: _items, ...row }): Domain.Entry => ({
          ...row,
          routine: routine !== 0,
          you: you !== 0,
          items: (byEntry[row.id] ?? []).map(
            ({ entryId: _entryId, ...item }) => item,
          ),
        }),
      );
    });

    const entryColumns = sql`
      id, kind, title, detail, url, job, run, routine, you, count, first_at,
      last_at, read_at
    `;

    const inbox = Effect.fn("Store.inbox")(function* (since: number) {
      const entries = yield* selectEntries(sql`
        SELECT ${entryColumns} FROM entries
        WHERE dismissed_at IS NULL AND (last_at >= ${since} OR read_at IS NULL)
        ORDER BY last_at DESC, id DESC
        LIMIT 500
      `);

      return { since, entries };
    }, Effect.mapError(storeError));

    const markRead = Effect.fn("Store.markRead")(function* (
      ids: ReadonlyArray<string> | undefined,
    ) {
      const now = yield* Clock.currentTimeMillis;

      if (ids === undefined) {
        yield* sql`UPDATE entries SET read_at = ${now} WHERE read_at IS NULL`;

        return;
      }

      if (ids.length === 0) return;

      yield* sql`
        UPDATE entries SET read_at = ${now}
        WHERE read_at IS NULL AND ${sql.in("id", ids)}
      `;
    }, Effect.mapError(storeError));

    const dismiss = Effect.fn("Store.dismiss")(function* (id: string) {
      const now = yield* Clock.currentTimeMillis;

      const [entry] = yield* selectEntries(sql`
        UPDATE entries SET dismissed_at = ${now}, read_at = coalesce(read_at, ${now})
        WHERE id = ${id}
        RETURNING ${entryColumns}
      `).pipe(Effect.mapError(storeError));

      if (entry === undefined) return yield* new Api.EntryNotFound({ id });

      return entry;
    });

    const known = Effect.fn("Store.known")(function* (
      commits: ReadonlyArray<Api.CommitRef>,
    ) {
      if (commits.length === 0) return [];

      const rows = yield* sql<{ repo: string; sha: string }>`
        SELECT repo, sha FROM entry_items
        WHERE ${sql.in(
          "sha",
          commits.map((commit) => commit.sha),
        )}
      `;

      const found = new Set(
        rows.map((row) => `${row.repo.toLowerCase()}@${row.sha}`),
      );

      return commits.filter((commit) =>
        found.has(`${commit.repo.toLowerCase()}@${commit.sha}`),
      );
    }, Effect.mapError(storeError));

    const seen = Effect.fn("Store.seen")(
      function* (commits: ReadonlyArray<Domain.Change>) {
        let added = 0;

        for (const commit of commits) {
          if (yield* placeChange(commit, null)) added += 1;
        }

        return added;
      },
      sql.withTransaction,
      Effect.mapError(storeError),
    );

    const pruneInbox = Effect.fn("Store.pruneInbox")(function* (
      before: number,
    ) {
      const rows = yield* sql`
        DELETE FROM entries
        WHERE last_at < ${before}
          AND (read_at IS NOT NULL OR dismissed_at IS NOT NULL)
        RETURNING id
      `;

      return rows.length;
    }, Effect.mapError(storeError));

    /**
     * Fill an empty inbox from the commits runs pushed in the last
     * `backfillHours`, so it starts with what happened lately. The watch
     * job fills in the commits made outside Upkeep.
     */
    const backfill = Effect.gen(function* () {
      const [count] = yield* sql<{ count: number }>`
        SELECT count(*) AS count FROM entries
      `;

      if ((count?.count ?? 0) > 0) return;

      const now = yield* Clock.currentTimeMillis;

      const pushed = yield* selectRuns(sql`
        SELECT * FROM runs
        WHERE queued_at >= ${now - backfillHours * 3_600_000} AND changes != '[]'
        ORDER BY queued_at, id
      `);

      for (const from of pushed) {
        for (const change of from.changes) yield* placeChange(change, from);
      }

      if (pushed.length > 0) {
        yield* Effect.logInfo(`Filled the inbox from ${pushed.length} runs`);
      }
    }).pipe(sql.withTransaction, Effect.mapError(storeError));

    const selectRepos = (
      statement: Effect.Effect<ReadonlyArray<unknown>, unknown>,
    ) => statement.pipe(Effect.flatMap(decodeRepos));

    const repos = Effect.fn("Store.repos")(function* () {
      return yield* selectRepos(sql`
        SELECT repo, jobs, added_at, title FROM repos ORDER BY repo COLLATE NOCASE
      `);
    }, Effect.mapError(storeError));

    const track = Effect.fn("Store.track")(function* (
      repo: string,
      jobs: ReadonlyArray<string>,
    ) {
      const [tracked] = yield* selectRepos(sql`
        INSERT INTO repos ${sql.insert({
          repo,
          jobs: JSON.stringify(jobs),
          addedAt: yield* Clock.currentTimeMillis,
        })}
        ON CONFLICT (repo) DO UPDATE
        SET repo = excluded.repo, jobs = excluded.jobs
        RETURNING repo, jobs, added_at, title
      `);

      if (tracked === undefined) {
        return yield* Effect.die(new Error("The tracked repo wasn't returned"));
      }

      return tracked;
    }, Effect.mapError(storeError));

    const untrack = Effect.fn("Store.untrack")(function* (repo: string) {
      const rows =
        yield* sql`DELETE FROM repos WHERE repo = ${repo} RETURNING repo`;

      return rows.length > 0;
    }, Effect.mapError(storeError));

    const setTitles = Effect.fn("Store.setTitles")(
      function* (titles: ReadonlyArray<Api.RepoTitle>) {
        for (const { repo, title } of titles) {
          yield* sql`UPDATE repos SET title = ${title} WHERE repo = ${repo}`;
        }
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

    yield* backfill.pipe(Effect.catchCause(Effect.logError));

    return Store.of({
      queueRun,
      runs,
      run,
      latestRuns,
      claim,
      heartbeat,
      appendLog,
      finish,
      updateHeal,
      report,
      activity,
      healsSince,
      heals,
      park,
      unpark,
      parked,
      pause,
      resume,
      paused,
      cancel,
      log,
      logTail,
      claimed,
      prune,
      requeue,
      failLost,
      recordReleases,
      inbox,
      markRead,
      dismiss,
      known,
      seen,
      needs,
      settle,
      pruneInbox,
      repos,
      track,
      untrack,
      setTitles,
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
