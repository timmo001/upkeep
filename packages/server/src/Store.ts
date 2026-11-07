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
import { SqlClient, type Statement } from "effect/sql";
import * as Attention from "./Attention";
import * as Entries from "./Entries";

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  cause: Schema.Defect(),
}) {}

/** Move one inbox entry's items and history into another, then drop it. */
const mergeEntry = (from: string, into: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`UPDATE entry_items SET entry_id = ${into} WHERE entry_id = ${from}`;
    yield* sql`
      UPDATE entries SET
        count = entries.count + other.count,
        first_at = min(entries.first_at, other.first_at),
        last_at = max(entries.last_at, other.last_at),
        routine = entries.routine AND other.routine,
        you = entries.you OR other.you,
        run = coalesce(other.run, entries.run),
        read_at = CASE
          WHEN entries.read_at IS NULL OR other.read_at IS NULL THEN NULL
          ELSE max(entries.read_at, other.read_at)
        END,
        dismissed_at = CASE
          WHEN entries.dismissed_at IS NULL OR other.dismissed_at IS NULL THEN NULL
          ELSE max(entries.dismissed_at, other.dismissed_at)
        END
      FROM (SELECT * FROM entries WHERE id = ${from}) AS other
      WHERE entries.id = ${into}
    `;
    yield* sql`DELETE FROM entries WHERE id = ${from}`;
  });

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
  // The name a repository shows by, set by hand or by a worker's `names`
  // command, and who set it
  "0011_repo_names": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`ALTER TABLE repos ADD COLUMN name TEXT`;
    yield* sql`ALTER TABLE repos ADD COLUMN named_by TEXT`;
  }),
  // A consumer's heal held back by the heal limit, one per job and consumer
  "0012_waiting_heals": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE waiting_heals (
        job TEXT NOT NULL,
        repo TEXT NOT NULL COLLATE NOCASE,
        run_id TEXT NOT NULL,
        issue TEXT,
        waiting_at INTEGER NOT NULL,
        PRIMARY KEY (job, repo)
      )
    `;
  }),
  // The stretch of the inbox a summary run covers, as JSON
  "0013_run_periods": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`ALTER TABLE runs ADD COLUMN period TEXT`;
  }),
  // Every version of the same update shares one entry now, so merge the
  // entries kept one per version, into the one with the key or the oldest
  "0014_grouped_updates": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql<{
      id: string;
      key: string;
      title: string;
    }>`
      SELECT id, key, title FROM entries
      WHERE kind = 'update'
      ORDER BY first_at, id
    `;

    const groups = Map.groupBy(rows, (row) => Entries.updateKey(row.title));

    for (const [key, group] of groups) {
      // An entry that already has the key keeps it, so it can't clash
      const target = group.find((row) => row.key === key) ?? group[0];

      if (target === undefined) continue;

      for (const row of group) {
        if (row.id !== target.id) yield* mergeEntry(row.id, target.id);
      }

      yield* sql`
        UPDATE entries SET key = ${key}, title = ${Entries.updateName(target.title)}
        WHERE id = ${target.id}
      `;
    }
  }),
  // A release a parked or paused job skipped, the latest per repository, to
  // queue once the job is let go
  "0015_held_releases": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE held_releases (
        job TEXT NOT NULL,
        repo TEXT NOT NULL COLLATE NOCASE,
        tag TEXT NOT NULL,
        url TEXT NOT NULL,
        held_at INTEGER NOT NULL,
        PRIMARY KEY (job, repo)
      )
    `;
  }),
  // The decision model a heal was chosen by, kept apart from its reason, the
  // model a summary was written by, and each worker's agents
  "0016_agents": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`ALTER TABLE runs ADD COLUMN heal_decided_by TEXT`;
    yield* sql`ALTER TABLE runs ADD COLUMN agent TEXT`;

    yield* sql`
      CREATE TABLE worker_agents (
        worker TEXT PRIMARY KEY,
        decisions TEXT,
        agents TEXT NOT NULL,
        at INTEGER NOT NULL
      )
    `;

    // Until now the reason ended by naming it, "(…, by provider/model)"
    const heals = yield* sql<{ id: string; healReason: string }>`
      SELECT id, heal_reason FROM runs WHERE heal_reason LIKE '%by %)'
    `;

    for (const heal of heals) {
      const by = /\bby ([\w.-]+\/[^)]+)\)$/.exec(heal.healReason)?.[1];

      if (by !== undefined) {
        yield* sql`UPDATE runs SET heal_decided_by = ${by} WHERE id = ${heal.id}`;
      }
    }
  }),
  // The Attention page: each item the attention job found, what moved on
  // them, and when the page was last looked at
  "0017_attention": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE attention_items (
        url TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        repo TEXT NOT NULL COLLATE NOCASE,
        number INTEGER,
        title TEXT NOT NULL,
        author TEXT,
        yours INTEGER NOT NULL,
        work INTEGER NOT NULL,
        you_acted_last INTEGER NOT NULL,
        involved INTEGER NOT NULL,
        activity_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        signals TEXT NOT NULL,
        notification TEXT,
        fingerprint TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        changed_at INTEGER NOT NULL
      )
    `;

    yield* sql`
      CREATE TABLE attention_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        repo TEXT NOT NULL,
        title TEXT NOT NULL,
        at INTEGER NOT NULL,
        what TEXT NOT NULL,
        gone INTEGER NOT NULL
      )
    `;
    yield* sql`CREATE INDEX attention_changes_at ON attention_changes (at)`;

    yield* sql`
      CREATE TABLE attention_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;
  }),
  // What a command run is asked to do, as JSON
  "0018_run_commands": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`ALTER TABLE runs ADD COLUMN command TEXT`;
  }),
  // The fingerprint an attention item was hidden at, so it comes back once
  // anything about it changes
  "0019_attention_hidden": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`ALTER TABLE attention_items ADD COLUMN hidden TEXT`;
  }),
  // Groups of work on the Attention page: the items in each and what each
  // waits on outside GitHub, what you told the agent, and its standing rules.
  // Links are keyed by the item's URL, not tied to its row, so they outlive
  // an item dropping off and coming back
  "0020_attention_groups": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE attention_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        focus TEXT NOT NULL,
        notes TEXT,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;

    yield* sql`
      CREATE TABLE attention_links (
        url TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        source TEXT NOT NULL,
        suggested INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;
    yield* sql`CREATE INDEX attention_links_group ON attention_links (group_id)`;

    yield* sql`
      CREATE TABLE attention_waits (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        text TEXT NOT NULL,
        url TEXT,
        recheck_at INTEGER,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;

    yield* sql`
      CREATE TABLE attention_comments (
        id TEXT PRIMARY KEY,
        url TEXT,
        group_id TEXT,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        outcome TEXT,
        done_at INTEGER
      )
    `;

    yield* sql`
      CREATE TABLE attention_rules (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        comment_id TEXT,
        created_at INTEGER NOT NULL
      )
    `;
  }),
  // An attention item's labels, as JSON, for its status and type
  "0021_attention_labels": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      ALTER TABLE attention_items ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'
    `;
  }),
  // The context agent's notes, keyed by URL like links so they outlive an
  // item dropping off; the group a gone item was in, for its follow-up; and
  // the follow-up itself
  "0022_attention_context": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE attention_notes (
        url TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        recheck_at INTEGER,
        fingerprint TEXT NOT NULL,
        at INTEGER NOT NULL
      )
    `;
    yield* sql`ALTER TABLE attention_changes ADD COLUMN group_id TEXT`;
    yield* sql`ALTER TABLE attention_groups ADD COLUMN follow_up TEXT`;
    yield* sql`ALTER TABLE attention_groups ADD COLUMN follow_up_at INTEGER`;
  }),
  // Whether a worker can open an agent for you from the Attention page
  "0023_worker_launch": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      ALTER TABLE worker_agents ADD COLUMN launch INTEGER NOT NULL DEFAULT 0
    `;
  }),
  // Skill changes an agent made, held for approval so any worker can land them
  "0024_skill_changes": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE skill_changes (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL COLLATE NOCASE,
        title TEXT NOT NULL,
        skills TEXT NOT NULL,
        work TEXT NOT NULL,
        reason TEXT NOT NULL,
        base TEXT,
        patch TEXT,
        subject TEXT,
        summary TEXT,
        session TEXT,
        worker TEXT NOT NULL,
        directory TEXT NOT NULL,
        state TEXT NOT NULL,
        commit_sha TEXT,
        note TEXT,
        at INTEGER NOT NULL
      )
    `;
    yield* sql`CREATE INDEX skill_changes_title ON skill_changes (repo, title)`;
  }),
  // Each repository's skills as a worker last read them, for the Skills page
  "0025_skills_state": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE skills_state (
        repo TEXT PRIMARY KEY COLLATE NOCASE,
        snapshot TEXT NOT NULL,
        at INTEGER NOT NULL
      )
    `;
  }),
  // Where a heal's agent worked on the worker, to open its session there
  "0026_heal_directory": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`ALTER TABLE runs ADD COLUMN heal_directory TEXT`;
  }),
  // Heal sessions their workers shared, so any worker can open them, and
  // which workers can open sessions at all
  "0027_heal_sessions": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE heal_sessions (
        run_id TEXT PRIMARY KEY,
        session TEXT NOT NULL,
        repo TEXT NOT NULL,
        export TEXT NOT NULL,
        at INTEGER NOT NULL
      )
    `;
    yield* sql`CREATE INDEX heal_sessions_session ON heal_sessions (session)`;
    yield* sql`
      ALTER TABLE runs ADD COLUMN heal_shared INTEGER NOT NULL DEFAULT 0
    `;
    yield* sql`
      ALTER TABLE worker_agents ADD COLUMN resume INTEGER NOT NULL DEFAULT 0
    `;
  }),
  // The one repository a run works on, when it was narrowed to one
  "0028_run_scope": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`ALTER TABLE runs ADD COLUMN scope_repo TEXT`;
  }),
  // GitHub's webhook deliveries pulled from the events queue, by delivery
  // ID, so a delivery the queue sends again is dropped
  "0029_github_events": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE github_events (
        delivery TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        action TEXT,
        repo TEXT NOT NULL,
        body TEXT NOT NULL,
        at INTEGER NOT NULL,
        received_at INTEGER NOT NULL
      )
    `;
    yield* sql`CREATE INDEX github_events_received ON github_events (received_at)`;
  }),
});

const RunRow = Schema.Struct({
  id: Schema.String,
  job: Schema.String,
  trigger: Domain.Trigger,
  releaseRepo: Schema.NullOr(Schema.String),
  releaseTag: Schema.NullOr(Schema.String),
  releaseUrl: Schema.NullOr(Schema.String),
  scopeRepo: Schema.NullOr(Schema.String),
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
  healDecidedBy: Schema.NullOr(Schema.String),
  healModel: Schema.NullOr(Schema.String),
  healVariant: Schema.NullOr(Schema.String),
  healActions: Schema.NullOr(
    Schema.fromJsonString(Schema.Array(Schema.String)),
  ),
  healCommit: Schema.NullOr(Schema.String),
  healSession: Schema.NullOr(Schema.String),
  healDirectory: Schema.NullOr(Schema.String),
  healShared: Schema.Number,
  healIssue: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  changes: Schema.fromJsonString(Schema.Array(Domain.Change)),
  attention: Schema.Number,
  period: Schema.NullOr(Schema.fromJsonString(Domain.Period)),
  agent: Schema.NullOr(Schema.fromJsonString(Domain.AgentModel)),
  command: Schema.NullOr(Schema.fromJsonString(Domain.Command)),
});

const decodeRuns = Schema.decodeUnknownEffect(Schema.Array(RunRow));

/** A heal's target as it's kept: `upkeep`, or the consumer's `owner/name`. */
const targetColumn = (target: Domain.Target) =>
  target.kind === "upkeep" ? "upkeep" : target.repo;

/** A summary's period or agent as it's kept: JSON, or NULL for other runs. */
const jsonColumn = (value: Domain.Period | Domain.AgentModel | null) =>
  value === null ? null : JSON.stringify(value);

const targetOf = (column: string): Domain.Target =>
  column === "upkeep" ? { kind: "upkeep" } : { kind: "consumer", repo: column };

const toRun = ({
  releaseRepo,
  releaseTag,
  releaseUrl,
  scopeRepo,
  healOf,
  healJob,
  healTarget,
  healDecision,
  healReason,
  healDecidedBy,
  healModel,
  healVariant,
  healActions,
  healCommit,
  healSession,
  healDirectory,
  healShared,
  healIssue,
  attention,
  ...row
}: typeof RunRow.Type): Domain.Run => ({
  ...row,
  repo: scopeRepo,
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
          decidedBy: healDecidedBy,
          model: healModel,
          variant: healVariant,
          actions: healActions ?? [],
          commit: healCommit,
          session: healSession,
          directory: healDirectory,
          shared: healShared !== 0,
          issue: healIssue,
        },
});

const decodeLog = Schema.decodeUnknownEffect(Schema.Array(Domain.LogLine));

const decodeEvents = Schema.decodeUnknownEffect(
  Schema.Array(Schema.fromJsonString(Domain.GitHubEvent)),
);

const decodeTokens = Schema.decodeUnknownEffect(Schema.Array(Api.Token));

const decodeReleases = Schema.decodeUnknownEffect(Schema.Array(Domain.Release));

const decodeAgents = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      ...Domain.WorkerAgents.fields,
      agents: Schema.fromJsonString(Schema.Array(Domain.Agent)),
      launch: Schema.Number,
      resume: Schema.Number,
    }),
  ),
);

const decodeSkillChanges = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      ...Domain.SkillChange.fields,
      skills: Schema.fromJsonString(Schema.Array(Schema.String)),
    }),
  ),
);

const decodeSnapshots = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ snapshot: Schema.fromJsonString(Domain.SkillsSnapshot) }),
  ),
);

const decodeParked = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ job: Schema.String, ...Domain.Parked.fields })),
);

const decodePaused = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ job: Schema.String, ...Domain.Paused.fields })),
);

/** A waiting heal as it's kept, with its job and triage issue. */
const WaitingRow = Schema.Struct({
  job: Domain.JobId,
  ...Domain.WaitingHeal.fields,
  issue: Schema.NullOr(Schema.String),
});

export interface Waiting extends Schema.Schema.Type<typeof WaitingRow> {}

const decodeWaiting = Schema.decodeUnknownEffect(Schema.Array(WaitingRow));

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

/** An attention item as it's kept, with its flags as numbers and JSON. */
const AttentionRow = Schema.Struct({
  ...Domain.AttentionFound.fields,
  yours: Schema.Number,
  work: Schema.Number,
  youActedLast: Schema.Number,
  involved: Schema.Number,
  signals: Schema.fromJsonString(Schema.Array(Domain.Signal)),
  labels: Schema.fromJsonString(Schema.Array(Schema.String)),
  notification: Schema.NullOr(
    Schema.fromJsonString(Domain.AttentionNotification),
  ),
  firstSeen: Schema.Finite,
  changedAt: Schema.Finite,
  hidden: Schema.NullOr(Schema.String),
});

type AttentionRow = typeof AttentionRow.Type;

const decodeAttention = Schema.decodeUnknownEffect(Schema.Array(AttentionRow));

const decodeAttentionChanges = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      ...Domain.AttentionChange.fields,
      what: Schema.fromJsonString(Schema.Array(Schema.String)),
      gone: Schema.Number,
    }),
  ),
);

const decodeAttentionNotes = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ ...Domain.AttentionNote.fields, url: Schema.String }),
  ),
);

const decodeAttentionReleases = Schema.decodeUnknownEffect(
  Domain.Attention.fields.releases,
);

const decodeAttentionGroups = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      focus: Domain.AttentionFocus,
      notes: Schema.NullOr(Schema.String),
      source: Domain.AttentionSource,
      createdAt: Schema.Finite,
      followUp: Schema.NullOr(Schema.String),
      followUpAt: Schema.NullOr(Schema.Finite),
    }),
  ),
);

const decodeAttentionLinks = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      url: Schema.String,
      groupId: Schema.String,
      source: Domain.AttentionSource,
      suggested: Schema.Number,
    }),
  ),
);

const decodeAttentionWaits = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ ...Domain.AttentionWait.fields, groupId: Schema.String }),
  ),
);

const decodeAttentionComments = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      url: Schema.NullOr(Schema.String),
      groupId: Schema.NullOr(Schema.String),
      text: Schema.String,
      createdAt: Schema.Finite,
      outcome: Schema.NullOr(Schema.String),
      doneAt: Schema.NullOr(Schema.Finite),
    }),
  ),
);

const decodeAttentionRules = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      text: Schema.String,
      commentId: Schema.NullOr(Schema.String),
      createdAt: Schema.Finite,
    }),
  ),
);

/** How many of your comments to the agent the page keeps showing. */
const attentionCommentLimit = 500;

/** A kept attention item, without where it sits, which depends on the time. */
const toFound = ({
  yours,
  work,
  youActedLast,
  involved,
  firstSeen,
  changedAt,
  hidden,
  ...row
}: AttentionRow) => ({
  found: {
    ...row,
    yours: yours !== 0,
    work: work !== 0,
    youActedLast: youActedLast !== 0,
    involved: involved !== 0,
  } satisfies Domain.AttentionFound,
  firstSeen,
  changedAt,
  hidden: hidden === row.fingerprint,
});

/** Within this long of the last look, a look is the same visit. */
const visitMs = 30 * 60_000;

/** How long what moved on attention items is kept. */
const attentionChangeDays = 30;

/** How far back Since you last looked reaches the first time. */
const firstLookHours = 24;

/** How far back the page's history of what went reaches. */
const goneDays = 7;

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
  /** The one repository it works on, or every one the job tracks without it. */
  readonly repo?: string | null;
  /** For a command run: what it's asked to do. */
  readonly command?: Domain.Command;
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
     * waiting, which is returned instead. A run for one repository is also
     * covered by a waiting run for every repository.
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
    /** The latest run of each of these machine jobs on each worker, by job. */
    machineRuns(
      jobs: ReadonlyArray<string>,
    ): Effect.Effect<
      ReadonlyMap<string, ReadonlyArray<Domain.Run>>,
      StoreError
    >;
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
    /** Keep the session a heal's agent left, from the worker running it. */
    shareSession(
      id: string,
      worker: string,
      shared: Api.SessionExport,
    ): Effect.Effect<void, Api.RunNotFound | Api.RunNotClaimed | StoreError>;
    /** A shared heal session, by its OpenCode session ID. */
    session(
      session: string,
    ): Effect.Effect<Api.SessionExport, Api.SessionNotFound | StoreError>;
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
    /**
     * Hold a consumer's heal until its heals free up, replacing an older one
     * for the same job and consumer.
     */
    wait(
      job: Domain.JobId,
      repo: string,
      run: string,
      issue: string | null,
    ): Effect.Effect<void, StoreError>;
    /** Drop a waiting heal, returning whether there was one. */
    stopWaiting(job: string, repo: string): Effect.Effect<boolean, StoreError>;
    /** Every waiting heal, oldest first. */
    waiting(): Effect.Effect<ReadonlyArray<Waiting>, StoreError>;
    /** Pause a job, keeping when and by whom when it's already paused. */
    pause(job: string, by: string): Effect.Effect<void, StoreError>;
    /** Resume a paused job, returning whether it was paused. */
    resume(job: string): Effect.Effect<boolean, StoreError>;
    /** The paused jobs, by job ID. */
    paused(): Effect.Effect<ReadonlyMap<string, Domain.Paused>, StoreError>;
    /**
     * Keep a release a parked or paused job skipped, so it runs once the job
     * is let go. A later release of the same repository replaces it.
     */
    hold(
      job: Domain.JobId,
      release: Domain.Release,
    ): Effect.Effect<void, StoreError>;
    /** Take the releases held for a job, oldest first, leaving none held. */
    takeHeld(
      job: string,
    ): Effect.Effect<ReadonlyArray<Domain.Release>, StoreError>;
    /** Keep the agents a worker said it's set up with, replacing its last. */
    setAgents(
      worker: string,
      setup: Domain.AgentSetup,
    ): Effect.Effect<void, StoreError>;
    /** Each worker's agents, by worker name. */
    agents(): Effect.Effect<ReadonlyArray<Domain.WorkerAgents>, StoreError>;
    /**
     * Keep a skill change from the worker running its agent. One now waiting
     * drops any other waiting on the same repository and title.
     */
    putSkillChange(
      id: string,
      worker: string,
      change: Api.SkillChangeInput,
    ): Effect.Effect<void, StoreError>;
    skillChange(
      id: string,
    ): Effect.Effect<Domain.SkillChange, Api.SkillChangeNotFound | StoreError>;
    /** The open skill changes, and those that ended in the last 30 days. */
    skillChanges(): Effect.Effect<
      ReadonlyArray<Domain.SkillChange>,
      StoreError
    >;
    setSkillChangeState(
      id: string,
      update: Api.SkillChangeStateUpdate,
    ): Effect.Effect<void, Api.SkillChangeNotFound | StoreError>;
    /** Keep a repository's skills, replacing what was last read of it. */
    putSkills(snapshot: Domain.SkillsSnapshot): Effect.Effect<void, StoreError>;
    /** The Skills page: every repository's skills, changes and workers. */
    skillsPage(): Effect.Effect<Domain.SkillsPage, StoreError>;
    /**
     * Keep what the attention job found: add new items, update the ones
     * whose fingerprint moved and record what moved, and, for a complete
     * snapshot, drop the ones it no longer found.
     */
    recordAttention(snapshot: Api.AttentionSnapshot): Effect.Effect<
      {
        readonly added: number;
        readonly changed: number;
        readonly gone: number;
      },
      StoreError
    >;
    /** The Attention page as of now. */
    attention(): Effect.Effect<Domain.Attention, StoreError>;
    /**
     * Note a look at the Attention page. A look more than half an hour after
     * the last starts a new visit, which shows what moved since that one.
     */
    looked(): Effect.Effect<void, StoreError>;
    /** Hide an attention item until anything about it changes, or show it. */
    hideAttention(
      url: string,
      hidden: boolean,
    ): Effect.Effect<void, StoreError>;
    /**
     * Show a notification as read before the next collection does: its items
     * lose their unread and mention signals, and one that's only the
     * notification is hidden, as it won't be found again.
     */
    markAttentionRead(thread: string): Effect.Effect<void, StoreError>;
    /** Start a group of work by hand, moving the items given into it. */
    createGroup(group: {
      readonly name: string;
      readonly focus?: Domain.AttentionFocus;
      readonly notes?: string | null;
      readonly items?: ReadonlyArray<string>;
    }): Effect.Effect<Domain.AttentionGroup, StoreError>;
    /** Rename a group, or change its focus or notes. */
    updateGroup(
      id: string,
      change: {
        readonly name?: string;
        readonly focus?: Domain.AttentionFocus;
        readonly notes?: string | null;
      },
    ): Effect.Effect<void, Api.GroupNotFound | StoreError>;
    /** Remove a group with its links, waits and comments. */
    deleteGroup(
      id: string,
    ): Effect.Effect<void, Api.GroupNotFound | StoreError>;
    /**
     * Move an item into a group by hand, accepting any suggestion, or out of
     * any group with null.
     */
    linkAttention(
      url: string,
      group: string | null,
    ): Effect.Effect<void, Api.GroupNotFound | StoreError>;
    /** Note something outside GitHub a group waits on. */
    addWait(
      group: string,
      wait: {
        readonly text: string;
        readonly url?: string | null;
        readonly recheckAt?: number | null;
      },
    ): Effect.Effect<Domain.AttentionWait, Api.GroupNotFound | StoreError>;
    removeWait(id: string): Effect.Effect<void, StoreError>;
    /** Keep something you told the agent about an item or a group. */
    commentAttention(
      comment:
        | { readonly url: string; readonly text: string }
        | { readonly group: string; readonly text: string },
    ): Effect.Effect<Domain.AttentionComment, Api.GroupNotFound | StoreError>;
    addRule(text: string): Effect.Effect<Domain.AttentionRule, StoreError>;
    removeRule(id: string): Effect.Effect<void, StoreError>;
    /**
     * Keep what the context agent made of the items and groups it was given.
     * Answers about a group or comment that's gone since are skipped.
     */
    recordContext(
      context: Api.AttentionContext,
    ): Effect.Effect<void, StoreError>;
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
    /**
     * Clear what a run left for a person: its attention, and the entry that
     * raised it, while it's still about this run.
     */
    dismissRun(
      id: string,
    ): Effect.Effect<Domain.Run, Api.RunNotFound | StoreError>;
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
    /**
     * Record a GitHub webhook delivery. Returns false when it was recorded
     * before, as a delivery the queue sends again is.
     */
    recordEvent(event: Domain.GitHubEvent): Effect.Effect<boolean, StoreError>;
    /** The GitHub events received since `since`, newest first. */
    events(
      since: number,
    ): Effect.Effect<ReadonlyArray<Domain.GitHubEvent>, StoreError>;
    /** Delete the GitHub events received before `before`. Returns how many went. */
    pruneEvents(before: number): Effect.Effect<number, StoreError>;
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
    /** Record names from a worker, leaving any name set by hand. */
    setNames(
      names: ReadonlyArray<Api.RepoLabel>,
    ): Effect.Effect<void, StoreError>;
    /**
     * Set a repository's name by hand, or clear it with null. None when it
     * isn't tracked.
     */
    rename(
      repo: string,
      name: string | null,
    ): Effect.Effect<Option.Option<Domain.TrackedRepo>, StoreError>;
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
      function* ({ job, trigger, release, repo, command, heal }: NewRun) {
        const commandColumn =
          command === undefined ? null : JSON.stringify(command);

        const scope = repo ?? null;

        // Repositories are matched ignoring case, as GitHub does, and a run
        // for every repository covers one for a single repository
        const waiting = yield* selectRuns(sql`
          SELECT * FROM runs
          WHERE job = ${job}
            AND state = 'queued'
            AND coalesce(release_repo, '') = ${release?.repo ?? ""}
            AND coalesce(release_tag, '') = ${release?.tag ?? ""}
            AND coalesce(command, '') = ${commandColumn ?? ""}
            AND coalesce(heal_of, '') = ${heal?.of ?? ""}
            AND coalesce(heal_target, '') = ${heal === undefined ? "" : targetColumn(heal.target)}
            AND (
              scope_repo IS NULL
              OR lower(scope_repo) = ${scope?.toLowerCase() ?? ""}
            )
          ORDER BY scope_repo IS NULL DESC
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
            scopeRepo: scope,
            command: commandColumn,
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

    const machineRuns = Effect.fn("Store.machineRuns")(function* (
      jobs: ReadonlyArray<string>,
    ) {
      if (jobs.length === 0) return new Map<string, Array<Domain.Run>>();

      const rows = yield* selectRuns(sql`
          SELECT * FROM runs AS r
          WHERE ${sql.in("job", jobs)}
            AND json_extract(command, '$.worker') IS NOT NULL
            AND id = (
              SELECT id FROM runs
              WHERE job = r.job
                AND json_extract(command, '$.worker')
                  = json_extract(r.command, '$.worker')
              ORDER BY queued_at DESC, id DESC LIMIT 1
            )
          ORDER BY json_extract(command, '$.worker')
        `);

      const byJob = new Map<string, Array<Domain.Run>>();

      for (const row of rows)
        byJob.set(row.job, [...(byJob.get(row.job) ?? []), row]);

      return byJob;
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
              -- A command for one worker waits for that one
              AND coalesce(json_extract(command, '$.worker'), ${worker})
                = ${worker}
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
            healDecidedBy: update.decidedBy ?? current.heal.decidedBy,
            healModel: update.model ?? current.heal.model,
            healVariant: update.variant ?? current.heal.variant,
            healActions: JSON.stringify(actions),
            healCommit: update.commit ?? current.heal.commit,
            healSession: update.session ?? current.heal.session,
            healDirectory: update.directory ?? current.heal.directory,
          })}
          WHERE id = ${id}
        `.pipe(Effect.mapError(storeError));
      },
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(storeError(cause))),
    );

    const shareSession = Effect.fn("Store.shareSession")(
      function* (id: string, worker: string, shared: Api.SessionExport) {
        yield* claimed(id, worker);

        const current = yield* run(id);

        if (current.heal?.session == null) return;

        yield* sql`
          INSERT OR REPLACE INTO heal_sessions ${sql.insert({
            runId: id,
            session: current.heal.session,
            repo: shared.repo,
            export: shared.export,
            at: yield* Clock.currentTimeMillis,
          })}
        `;
        yield* sql`UPDATE runs SET heal_shared = 1 WHERE id = ${id}`;
      },
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(storeError(cause))),
    );

    const session = Effect.fn("Store.session")(function* (id: string) {
      const rows = yield* sql<{
        readonly repo: string;
        readonly export: string;
      }>`
        SELECT repo, export FROM heal_sessions
        WHERE session = ${id} ORDER BY at DESC LIMIT 1
      `.pipe(Effect.mapError(storeError));

      const [found] = rows;

      if (found === undefined) return yield* new Api.SessionNotFound({ id });

      return { repo: found.repo, export: found.export };
    });

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
            period: jsonColumn(update.period ?? current.period),
            agent: jsonColumn(update.agent ?? current.agent),
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

    const wait = Effect.fn("Store.wait")(function* (
      job: Domain.JobId,
      repo: string,
      runId: string,
      issue: string | null,
    ) {
      yield* sql`
        INSERT INTO waiting_heals ${sql.insert({
          job,
          repo,
          runId,
          issue,
          waitingAt: yield* Clock.currentTimeMillis,
        })}
        ON CONFLICT (job, repo) DO UPDATE
        SET run_id = excluded.run_id, issue = excluded.issue,
          waiting_at = excluded.waiting_at
      `;
    }, Effect.mapError(storeError));

    const stopWaiting = Effect.fn("Store.stopWaiting")(function* (
      job: string,
      repo: string,
    ) {
      const rows = yield* sql`
        DELETE FROM waiting_heals WHERE job = ${job} AND repo = ${repo}
        RETURNING job
      `;

      return rows.length > 0;
    }, Effect.mapError(storeError));

    const waiting = Effect.fn("Store.waiting")(function* () {
      return yield* sql`
        SELECT job, repo, run_id AS run, issue, waiting_at AS at
        FROM waiting_heals ORDER BY waiting_at
      `.pipe(Effect.flatMap(decodeWaiting));
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

    const hold = Effect.fn("Store.hold")(function* (
      job: Domain.JobId,
      release: Domain.Release,
    ) {
      yield* sql`
        INSERT INTO held_releases ${sql.insert({
          job,
          repo: release.repo,
          tag: release.tag,
          url: release.url,
          heldAt: yield* Clock.currentTimeMillis,
        })}
        ON CONFLICT (job, repo) DO UPDATE
        SET tag = excluded.tag, url = excluded.url, held_at = excluded.held_at
      `;
    }, Effect.mapError(storeError));

    const takeHeld = Effect.fn("Store.takeHeld")(
      function* (job: string) {
        return yield* sql`
          DELETE FROM held_releases WHERE job = ${job}
          RETURNING repo, tag, url, held_at
        `.pipe(
          Effect.map((rows) =>
            rows.toSorted((a, b) => Number(a["heldAt"]) - Number(b["heldAt"])),
          ),
          Effect.flatMap(decodeReleases),
        );
      },
      sql.withTransaction,
      Effect.mapError(storeError),
    );

    const setAgents = Effect.fn("Store.setAgents")(function* (
      worker: string,
      setup: Domain.AgentSetup,
    ) {
      yield* sql`
        INSERT INTO worker_agents ${sql.insert({
          worker,
          decisions: setup.decisions,
          agents: JSON.stringify(setup.agents),
          launch: setup.launch ? 1 : 0,
          resume: setup.resume ? 1 : 0,
          at: yield* Clock.currentTimeMillis,
        })}
        ON CONFLICT (worker) DO UPDATE
        SET decisions = excluded.decisions, agents = excluded.agents,
          launch = excluded.launch, resume = excluded.resume, at = excluded.at
      `;
    }, Effect.mapError(storeError));

    const agents = Effect.fn("Store.agents")(function* () {
      return yield* sql`
        SELECT worker, decisions, agents, launch, resume, at
        FROM worker_agents ORDER BY worker
      `.pipe(
        Effect.flatMap(decodeAgents),
        Effect.map((rows) =>
          rows.map(({ launch, resume, ...row }): Domain.WorkerAgents => ({
            ...row,
            launch: launch !== 0,
            resume: resume !== 0,
          })),
        ),
      );
    }, Effect.mapError(storeError));

    const selectSkillChanges = (condition: Statement.Fragment) =>
      sql`
        SELECT id, repo, title, skills, work, reason, base, patch, subject,
          summary, session, worker, directory, state, commit_sha AS "commit",
          note, at
        FROM skill_changes WHERE ${condition}
        ORDER BY at DESC, id DESC
      `.pipe(Effect.flatMap(decodeSkillChanges));

    const putSkillChange = Effect.fn("Store.putSkillChange")(
      function* (id: string, worker: string, change: Api.SkillChangeInput) {
        const at = yield* Clock.currentTimeMillis;

        if (change.state === "waiting") {
          yield* sql`
            UPDATE skill_changes SET state = 'dropped', at = ${at}
            WHERE repo = ${change.repo} AND title = ${change.title}
              AND state = 'waiting' AND id != ${id}
          `;
        }

        yield* sql`
          INSERT INTO skill_changes ${sql.insert({
            id,
            repo: change.repo,
            title: change.title,
            skills: JSON.stringify(change.skills),
            work: change.work,
            reason: change.reason,
            base: change.base,
            patch: change.patch,
            subject: change.subject,
            summary: change.summary,
            session: change.session,
            worker,
            directory: change.directory,
            state: change.state,
            commitSha: change.commit,
            note: change.note,
            at,
          })}
          ON CONFLICT (id) DO UPDATE
          SET repo = excluded.repo, title = excluded.title,
            skills = excluded.skills, work = excluded.work,
            reason = excluded.reason, base = excluded.base,
            patch = excluded.patch, subject = excluded.subject,
            summary = excluded.summary, session = excluded.session,
            worker = excluded.worker, directory = excluded.directory,
            state = excluded.state, commit_sha = excluded.commit_sha,
            note = excluded.note, at = excluded.at
        `;
      },
      sql.withTransaction,
      Effect.mapError(storeError),
    );

    const skillChange = Effect.fn("Store.skillChange")(function* (id: string) {
      const [found] = yield* selectSkillChanges(sql`id = ${id}`).pipe(
        Effect.mapError(storeError),
      );

      if (found === undefined)
        return yield* new Api.SkillChangeNotFound({ id });

      return found;
    });

    const skillChanges = Effect.fn("Store.skillChanges")(function* () {
      const since = (yield* Clock.currentTimeMillis) - 30 * 86_400_000;

      return yield* selectSkillChanges(
        sql`state IN ('working', 'waiting', 'applying', 'stale') OR at >= ${since}`,
      );
    }, Effect.mapError(storeError));

    const setSkillChangeState = Effect.fn("Store.setSkillChangeState")(
      function* (id: string, update: Api.SkillChangeStateUpdate) {
        const rows = yield* sql`
          UPDATE skill_changes
          SET state = ${update.state},
            commit_sha = coalesce(${update.commit ?? null}, commit_sha),
            note = ${update.note === undefined ? sql`note` : update.note},
            at = ${yield* Clock.currentTimeMillis}
          WHERE id = ${id}
          RETURNING id
        `.pipe(Effect.mapError(storeError));

        if (rows.length === 0)
          return yield* new Api.SkillChangeNotFound({ id });
      },
    );

    const putSkills = Effect.fn("Store.putSkills")(function* (
      snapshot: Domain.SkillsSnapshot,
    ) {
      yield* sql`
        INSERT INTO skills_state ${sql.insert({
          repo: snapshot.repo,
          snapshot: JSON.stringify(snapshot),
          at: snapshot.checkedAt,
        })}
        ON CONFLICT (repo) DO UPDATE
        SET snapshot = excluded.snapshot, at = excluded.at
      `;
    }, Effect.mapError(storeError));

    const skillsPage = Effect.fn("Store.skillsPage")(function* () {
      const repos = yield* sql`
        SELECT snapshot FROM skills_state ORDER BY repo
      `.pipe(Effect.flatMap(decodeSnapshots), Effect.mapError(storeError));

      return {
        repos: repos.map((row) => row.snapshot),
        changes: yield* skillChanges(),
        workers: (yield* agents()).map(({ worker, at, launch }) => ({
          worker,
          at,
          launch,
        })),
      };
    });

    const attentionState = Effect.fnUntraced(function* () {
      const rows = yield* sql<{ key: string; value: string }>`
        SELECT key, value FROM attention_state
      `;

      return new Map(rows.map(({ key, value }) => [key, value]));
    });

    const setAttentionState = (key: string, value: string) =>
      sql`
        INSERT INTO attention_state ${sql.insert({ key, value })}
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `;

    const numberOf = (value: string | undefined) =>
      value === undefined ? null : Number(value);

    /**
     * Form GitHub's groups again from how the items tie together. A group
     * that mostly carries on keeps its ID, so its focus, notes and waits stay,
     * and one left empty goes unless you added something to it.
     */
    const formGroups = Effect.fnUntraced(function* (
      relations: ReadonlyArray<Domain.AttentionRelation>,
      now: number,
    ) {
      const items = yield* sql<{ url: string; kind: string; title: string }>`
        SELECT url, kind, title FROM attention_items
      `;

      const links = yield* sql<{
        url: string;
        groupId: string;
        source: string;
      }>`
        SELECT url, group_id, source FROM attention_links
      `;

      const apart = new Set(
        links.flatMap((link) => (link.source === "github" ? [] : [link.url])),
      );

      const before = new Map(
        links.flatMap((link) =>
          link.source === "github" ? [[link.url, link.groupId] as const] : [],
        ),
      );

      yield* sql`DELETE FROM attention_links WHERE source = 'github'`;

      const used = new Set<string>();

      for (const work of Attention.workOf(relations, items, apart)) {
        const votes = new Map<string, number>();

        for (const url of work.urls) {
          const id = before.get(url);

          if (id !== undefined && !used.has(id)) {
            votes.set(id, (votes.get(id) ?? 0) + 1);
          }
        }

        const [carried] = [...votes].toSorted((a, b) => b[1] - a[1]);
        const id = carried?.[0] ?? (yield* random.ulid);

        if (carried === undefined) {
          yield* sql`
            INSERT INTO attention_groups ${sql.insert({
              id,
              name: work.name,
              focus: "watching",
              notes: null,
              source: "github",
              createdAt: now,
            })}
          `;
        }

        used.add(id);

        for (const url of work.urls) {
          yield* sql`
            INSERT INTO attention_links ${sql.insert({
              url,
              groupId: id,
              source: "github",
              suggested: 0,
              createdAt: now,
            })}
          `;
        }
      }

      yield* sql`
        DELETE FROM attention_groups
        WHERE source = 'github'
          AND focus = 'watching'
          AND notes IS NULL
          AND id NOT IN (SELECT group_id FROM attention_links)
          AND id NOT IN (SELECT group_id FROM attention_waits)
      `;
      yield* sql`
        DELETE FROM attention_comments
        WHERE group_id IS NOT NULL
          AND group_id NOT IN (SELECT id FROM attention_groups)
      `;
    });

    const recordAttention = Effect.fn("Store.recordAttention")(
      function* (snapshot: Api.AttentionSnapshot) {
        const now = yield* Clock.currentTimeMillis;
        const state = yield* attentionState();

        // The first collection has nothing to compare with, so it isn't
        // shown as everything being new
        const first = !state.has("collected_at");

        const kept = new Map(
          (yield* sql`SELECT * FROM attention_items`.pipe(
            Effect.flatMap(decodeAttention),
          )).map((row) => [row.url, toFound(row)]),
        );

        const counts = { added: 0, changed: 0, gone: 0 };

        const logChange = (
          item: Pick<Domain.AttentionFound, "url" | "repo" | "title">,
          what: ReadonlyArray<string>,
          gone: boolean,
          group: string | null = null,
        ) =>
          first
            ? Effect.void
            : sql`
                INSERT INTO attention_changes ${sql.insert({
                  url: item.url,
                  repo: item.repo,
                  title: item.title,
                  at: now,
                  what: JSON.stringify(what),
                  gone: gone ? 1 : 0,
                  groupId: group,
                })}
              `;

        for (const item of snapshot.items) {
          const before = kept.get(item.url);

          kept.delete(item.url);

          if (
            before !== undefined &&
            before.found.fingerprint === item.fingerprint &&
            before.found.work === item.work
          ) {
            // Labels kept before workers sent them fill in quietly
            const labels = JSON.stringify(item.labels);

            if (JSON.stringify(before.found.labels) !== labels) {
              yield* sql`
                UPDATE attention_items SET labels = ${labels}
                WHERE url = ${item.url}
              `;
            }

            continue;
          }

          const what = Attention.whatMoved(before?.found, item);

          yield* sql`
            INSERT OR REPLACE INTO attention_items ${sql.insert({
              ...item,
              yours: item.yours ? 1 : 0,
              work: item.work ? 1 : 0,
              youActedLast: item.youActedLast ? 1 : 0,
              involved: item.involved ? 1 : 0,
              signals: JSON.stringify(item.signals),
              labels: JSON.stringify(item.labels),
              notification:
                item.notification === null
                  ? null
                  : JSON.stringify(item.notification),
              firstSeen: before?.firstSeen ?? now,
              changedAt: now,
            })}
          `;

          if (before === undefined) counts.added += 1;
          else counts.changed += 1;

          // Activity with nothing to say is only worth showing on your own
          if (what.length > 1 || what[0] !== "Updated" || item.yours) {
            yield* logChange(item, what, false);
          }
        }

        if (snapshot.complete) {
          for (const { found } of kept.values()) {
            // Read before GitHub's groups are formed again without it
            const [link] = yield* sql<{ groupId: string }>`
              SELECT group_id FROM attention_links WHERE url = ${found.url}
            `;

            yield* sql`DELETE FROM attention_items WHERE url = ${found.url}`;
            yield* logChange(
              found,
              ["Closed, or no longer involves you"],
              true,
              link?.groupId ?? null,
            );
            counts.gone += 1;
          }
        }

        if (snapshot.relations !== undefined) {
          yield* formGroups(snapshot.relations, now);
        }

        yield* setAttentionState("collected_at", `${now}`);
        yield* setAttentionState("stale_days", `${snapshot.staleDays}`);
        yield* setAttentionState(
          "work_time",
          snapshot.workTime === null ? "" : `${snapshot.workTime}`,
        );
        yield* sql`
          DELETE FROM attention_changes
          WHERE at < ${now - attentionChangeDays * 86_400_000}
        `;

        return counts;
      },
      sql.withTransaction,
      Effect.mapError(storeError),
    );

    const attention = Effect.fn("Store.attention")(function* () {
      const now = yield* Clock.currentTimeMillis;
      const state = yield* attentionState();
      const staleDays = numberOf(state.get("stale_days")) ?? 14;
      const since = numberOf(state.get("since"));
      const workTime = state.get("work_time");

      // Repositories with a run that left something for a person
      const needing = new Set(
        (yield* sql<{ repo: string }>`
          SELECT DISTINCT lower(coalesce(heal_target, release_repo)) AS repo
          FROM runs
          WHERE attention = 1
            AND coalesce(heal_target, release_repo) IS NOT NULL
        `).map(({ repo }) => repo),
      );

      const rows = yield* sql`
        SELECT * FROM attention_items ORDER BY changed_at DESC
      `.pipe(Effect.flatMap(decodeAttention));

      const notes = new Map(
        (yield* sql`SELECT * FROM attention_notes`.pipe(
          Effect.flatMap(decodeAttentionNotes),
        )).map(({ url, ...note }) => [url, note]),
      );

      const items = rows.map((row): Domain.AttentionItem => {
        const { found, firstSeen, changedAt, hidden } = toFound(row);

        const signals =
          found.yours && needing.has(found.repo.toLowerCase())
            ? [...found.signals, { kind: "upkeep" as const, detail: null }]
            : found.signals;

        const note = notes.get(found.url) ?? null;

        // A note keeps it out of Going stale until its recheck date, and
        // only while nothing about the item has moved since
        const noted =
          note !== null &&
          note.fingerprint === found.fingerprint &&
          note.recheckAt !== null &&
          note.recheckAt > now;

        return {
          ...found,
          signals,
          section: Attention.sectionOf(
            { ...found, signals, noted },
            now,
            staleDays,
          ),
          firstSeen,
          changedAt,
          hidden,
          note,
        };
      });

      // What moved since you last looked, and what went over the last week
      // whenever you looked, which the page keeps apart as a history
      const changes = yield* sql`
        SELECT url, repo, title, at, what, gone, group_id AS "group"
        FROM attention_changes
        WHERE (gone = 0 AND at > ${since ?? now - firstLookHours * 3_600_000})
          OR (gone = 1 AND at > ${now - goneDays * 86_400_000})
        ORDER BY at DESC
        LIMIT 1000
      `.pipe(Effect.flatMap(decodeAttentionChanges));

      const releases = yield* sql`
        SELECT repo, tag, url, seen_at FROM releases ORDER BY seen_at DESC
      `.pipe(Effect.flatMap(decodeAttentionReleases));

      const links = yield* sql`
        SELECT url, group_id, source, suggested FROM attention_links
        ORDER BY created_at
      `.pipe(Effect.flatMap(decodeAttentionLinks));

      const waits = yield* sql`
        SELECT * FROM attention_waits ORDER BY created_at
      `.pipe(Effect.flatMap(decodeAttentionWaits));

      const groups = (yield* sql`
        SELECT * FROM attention_groups ORDER BY created_at
      `.pipe(Effect.flatMap(decodeAttentionGroups))).map(
        ({ followUp, followUpAt, ...group }): Domain.AttentionGroup => ({
          ...group,
          followUp:
            followUp === null
              ? null
              : { text: followUp, at: followUpAt ?? group.createdAt },
          items: links.flatMap(({ groupId, suggested, ...link }) =>
            groupId === group.id
              ? [{ ...link, suggested: suggested !== 0 }]
              : [],
          ),
          waits: waits.flatMap(({ groupId, ...wait }) =>
            groupId === group.id ? [wait] : [],
          ),
        }),
      );

      const comments = (yield* sql`
        SELECT * FROM attention_comments
        ORDER BY created_at DESC
        LIMIT ${attentionCommentLimit}
      `.pipe(Effect.flatMap(decodeAttentionComments))).map(
        ({ groupId, ...comment }): Domain.AttentionComment => ({
          ...comment,
          group: groupId,
        }),
      );

      const rules = (yield* sql`
        SELECT * FROM attention_rules ORDER BY created_at
      `.pipe(Effect.flatMap(decodeAttentionRules))).map(
        ({ commentId, ...rule }): Domain.AttentionRule => ({
          ...rule,
          comment: commentId,
        }),
      );

      // The refresh endpoint's rule: a run waiting, running or finished
      // within the window means a refresh would queue nothing
      const [last] = yield* sql<{
        state: string;
        finishedAt: number | null;
        queuedAt: number;
      }>`
        SELECT state, finished_at, queued_at FROM runs
        WHERE job = ${Catalogue.attention.id}
        ORDER BY queued_at DESC
        LIMIT 1
      `;

      const refreshAt =
        last === undefined ||
        last.state === "queued" ||
        last.state === "running"
          ? null
          : (last.finishedAt ?? last.queuedAt) + Api.attentionRefreshMs;

      return {
        items,
        groups,
        comments,
        rules,
        releases,
        refreshAt: refreshAt !== null && refreshAt > now ? refreshAt : null,
        changes: changes.map((change) => ({
          ...change,
          gone: change.gone !== 0,
        })),
        since,
        collectedAt: numberOf(state.get("collected_at")),
        workTime:
          workTime === undefined || workTime === ""
            ? null
            : workTime === "true",
        staleDays,
      } satisfies Domain.Attention;
    }, Effect.mapError(storeError));

    const looked = Effect.fn("Store.looked")(
      function* () {
        const now = yield* Clock.currentTimeMillis;
        const last = numberOf((yield* attentionState()).get("looked"));

        // A new visit shows what moved since the last one
        if (last !== null && now - last > visitMs) {
          yield* setAttentionState("since", `${last}`);
        }

        yield* setAttentionState("looked", `${now}`);
      },
      sql.withTransaction,
      Effect.mapError(storeError),
    );

    const hideAttention = Effect.fn("Store.hideAttention")(function* (
      url: string,
      hidden: boolean,
    ) {
      yield* sql`
          UPDATE attention_items
          SET hidden = ${hidden ? sql`fingerprint` : null}
          WHERE url = ${url}
        `;
    }, Effect.mapError(storeError));

    // Signals only a notification gives, which reading it settles
    const settled: ReadonlySet<Domain.SignalKind> = new Set([
      "unread",
      "mentioned",
    ]);

    const markAttentionRead = Effect.fn("Store.markAttentionRead")(
      function* (thread: string) {
        const rows = yield* sql`
          SELECT * FROM attention_items
          WHERE json_extract(notification, '$.id') = ${thread}
        `.pipe(Effect.flatMap(decodeAttention));

        for (const row of rows) {
          const { found } = toFound(row);

          const notification =
            found.notification === null
              ? null
              : { ...found.notification, unread: false };

          yield* sql`
            UPDATE attention_items
            SET notification = ${JSON.stringify(notification)},
              signals = ${JSON.stringify(
                found.signals.filter((signal) => !settled.has(signal.kind)),
              )},
              hidden = ${found.kind === "notification" ? sql`fingerprint` : sql`hidden`}
            WHERE url = ${found.url}
          `;
        }
      },
      sql.withTransaction,
      Effect.mapError(storeError),
    );

    const requireGroup = Effect.fnUntraced(function* (id: string) {
      const rows = yield* sql`SELECT id FROM attention_groups WHERE id = ${id}`;

      if (rows.length === 0) return yield* new Api.GroupNotFound({ id });
    });

    // An item sits in one group at most, so linking it moves it
    const putLink = Effect.fnUntraced(function* (
      url: string,
      group: string,
      now: number,
    ) {
      yield* sql`
        INSERT INTO attention_links ${sql.insert({
          url,
          groupId: group,
          source: "you",
          suggested: 0,
          createdAt: now,
        })}
        ON CONFLICT (url) DO UPDATE SET
          group_id = excluded.group_id,
          source = excluded.source,
          suggested = 0,
          created_at = excluded.created_at
      `;
    });

    const createGroup = Effect.fn("Store.createGroup")(
      function* ({
        name,
        focus = "watching",
        notes = null,
        items = [],
      }: {
        readonly name: string;
        readonly focus?: Domain.AttentionFocus;
        readonly notes?: string | null;
        readonly items?: ReadonlyArray<string>;
      }) {
        const now = yield* Clock.currentTimeMillis;

        const group = {
          id: yield* random.ulid,
          name,
          focus,
          notes,
          source: "you" as const,
          createdAt: now,
        };

        yield* sql`INSERT INTO attention_groups ${sql.insert(group)}`;

        for (const url of items) yield* putLink(url, group.id, now);

        return {
          ...group,
          items: items.map((url) => ({
            url,
            source: "you" as const,
            suggested: false,
          })),
          waits: [],
          followUp: null,
        } satisfies Domain.AttentionGroup;
      },
      sql.withTransaction,
      Effect.mapError(storeError),
    );

    const updateGroup = Effect.fn("Store.updateGroup")(
      function* (
        id: string,
        change: {
          readonly name?: string;
          readonly focus?: Domain.AttentionFocus;
          readonly notes?: string | null;
        },
      ) {
        yield* requireGroup(id);

        yield* sql`
          UPDATE attention_groups SET
            name = coalesce(${change.name ?? null}, name),
            focus = coalesce(${change.focus ?? null}, focus),
            notes = ${change.notes === undefined ? sql`notes` : change.notes}
          WHERE id = ${id}
        `;
      },
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(storeError(cause))),
    );

    const deleteGroup = Effect.fn("Store.deleteGroup")(
      function* (id: string) {
        yield* requireGroup(id);
        yield* sql`DELETE FROM attention_links WHERE group_id = ${id}`;
        yield* sql`DELETE FROM attention_waits WHERE group_id = ${id}`;
        yield* sql`DELETE FROM attention_comments WHERE group_id = ${id}`;
        yield* sql`DELETE FROM attention_groups WHERE id = ${id}`;
      },
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(storeError(cause))),
    );

    const linkAttention = Effect.fn("Store.linkAttention")(
      function* (url: string, group: string | null) {
        if (group === null) {
          yield* sql`DELETE FROM attention_links WHERE url = ${url}`;

          return;
        }

        yield* requireGroup(group);
        yield* putLink(url, group, yield* Clock.currentTimeMillis);
      },
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(storeError(cause))),
    );

    const addWait = Effect.fn("Store.addWait")(
      function* (
        group: string,
        {
          text,
          url = null,
          recheckAt = null,
        }: {
          readonly text: string;
          readonly url?: string | null;
          readonly recheckAt?: number | null;
        },
      ) {
        yield* requireGroup(group);

        const wait = {
          id: yield* random.ulid,
          text,
          url,
          recheckAt,
          source: "you" as const,
          createdAt: yield* Clock.currentTimeMillis,
        } satisfies Domain.AttentionWait;

        yield* sql`
          INSERT INTO attention_waits ${sql.insert({ ...wait, groupId: group })}
        `;

        return wait;
      },
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(storeError(cause))),
    );

    const removeWait = Effect.fn("Store.removeWait")(function* (id: string) {
      yield* sql`DELETE FROM attention_waits WHERE id = ${id}`;
    }, Effect.mapError(storeError));

    const commentAttention = Effect.fn("Store.commentAttention")(
      function* (
        target:
          | { readonly url: string; readonly text: string }
          | { readonly group: string; readonly text: string },
      ) {
        const group = "group" in target ? target.group : null;

        if (group !== null) yield* requireGroup(group);

        const comment = {
          id: yield* random.ulid,
          url: "url" in target ? target.url : null,
          group,
          text: target.text,
          createdAt: yield* Clock.currentTimeMillis,
          outcome: null,
          doneAt: null,
        } satisfies Domain.AttentionComment;

        yield* sql`
          INSERT INTO attention_comments ${sql.insert({
            id: comment.id,
            url: comment.url,
            groupId: group,
            text: comment.text,
            createdAt: comment.createdAt,
          })}
        `;

        return comment;
      },
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(storeError(cause))),
    );

    const addRule = Effect.fn("Store.addRule")(function* (text: string) {
      const rule = {
        id: yield* random.ulid,
        text,
        comment: null,
        createdAt: yield* Clock.currentTimeMillis,
      } satisfies Domain.AttentionRule;

      yield* sql`
        INSERT INTO attention_rules ${sql.insert({
          id: rule.id,
          text,
          createdAt: rule.createdAt,
        })}
      `;

      return rule;
    }, Effect.mapError(storeError));

    const removeRule = Effect.fn("Store.removeRule")(function* (id: string) {
      yield* sql`DELETE FROM attention_rules WHERE id = ${id}`;
    }, Effect.mapError(storeError));

    const recordContext = Effect.fn("Store.recordContext")(
      function* (context: Api.AttentionContext) {
        const now = yield* Clock.currentTimeMillis;

        const groups = new Set(
          (yield* sql<{ id: string }>`SELECT id FROM attention_groups`).map(
            ({ id }) => id,
          ),
        );

        for (const note of context.notes) {
          yield* sql`
            INSERT OR REPLACE INTO attention_notes ${sql.insert({
              url: note.url,
              text: note.text,
              recheckAt: note.recheckAt,
              fingerprint: note.fingerprint,
              at: now,
            })}
          `;
        }

        for (const followUp of context.followUps) {
          if (!groups.has(followUp.group)) continue;

          yield* sql`
            UPDATE attention_groups
            SET follow_up = ${followUp.text}, follow_up_at = ${now}
            WHERE id = ${followUp.group}
          `;
        }

        for (const answer of context.comments) {
          const [comment] = yield* sql<{ id: string }>`
            SELECT id FROM attention_comments
            WHERE id = ${answer.id} AND done_at IS NULL
          `;

          if (comment === undefined) continue;

          yield* sql`
            UPDATE attention_comments
            SET outcome = ${answer.outcome}, done_at = ${now}
            WHERE id = ${answer.id}
          `;

          if (answer.rule !== null) {
            yield* sql`
              INSERT INTO attention_rules ${sql.insert({
                id: yield* random.ulid,
                text: answer.rule,
                commentId: answer.id,
                createdAt: now,
              })}
            `;
          }
        }

        for (const link of context.links) {
          if (link.group === null) {
            // Only what the agent or GitHub put there; your own links stay
            yield* sql`
              DELETE FROM attention_links
              WHERE url = ${link.url} AND source != 'you'
            `;

            continue;
          }

          if (!groups.has(link.group)) continue;

          const row = {
            url: link.url,
            groupId: link.group,
            source: "agent",
            suggested: link.suggested ? 1 : 0,
            createdAt: now,
          };

          // A suggestion never moves an item out of a group it's in
          yield* link.suggested
            ? sql`INSERT OR IGNORE INTO attention_links ${sql.insert(row)}`
            : sql`INSERT OR REPLACE INTO attention_links ${sql.insert(row)}`;
        }
      },
      sql.withTransaction,
      Effect.mapError(storeError),
    );

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
        yield* sql`DELETE FROM heal_sessions WHERE run_id IN (${doomed})`;

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

    // A RETURNING clause only reads the table it changes, so the job of an
    // entry's run is read separately, for the inbox
    const entryColumns = sql`
      id, kind, title, detail, url, job, run, routine, you, count, first_at,
      last_at, read_at, NULL AS run_job
    `;

    const inbox = Effect.fn("Store.inbox")(function* (since: number) {
      const entries = yield* selectEntries(sql`
        SELECT
          id, kind, title, detail, url, job, run, routine, you, count,
          first_at, last_at, read_at,
          (SELECT runs.job FROM runs WHERE runs.id = entries.run) AS run_job
        FROM entries
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

    const dismiss = Effect.fn("Store.dismiss")(
      function* (id: string) {
        const now = yield* Clock.currentTimeMillis;

        const [entry] = yield* selectEntries(sql`
          UPDATE entries SET dismissed_at = ${now}, read_at = coalesce(read_at, ${now})
          WHERE id = ${id}
          RETURNING ${entryColumns}
        `).pipe(Effect.mapError(storeError));

        if (entry === undefined) return yield* new Api.EntryNotFound({ id });

        if (entry.kind !== "needs") return entry;

        // A heal's entry is shared by every heal of its job that chose the
        // same, so each of those runs is dealt with, not only the latest.
        const [row] = yield* sql<{ key: string }>`
          SELECT key FROM entries WHERE id = ${id}
        `;

        const heal = /^needs:heal:(.+):(\w+)$/.exec(row?.key ?? "");

        yield* sql`
          UPDATE runs SET attention = 0
          WHERE attention = 1 AND (
            id = ${entry.run}
            ${
              heal === null
                ? sql``
                : sql`OR (heal_job = ${heal[1]} AND coalesce(heal_decision, 'ask') = ${heal[2]})`
            }
          )
        `;

        return entry;
      },
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(storeError(cause))),
    );

    const dismissRun = Effect.fn("Store.dismissRun")(
      function* (id: string) {
        yield* run(id);

        yield* sql`
          UPDATE entries
          SET dismissed_at = ${yield* Clock.currentTimeMillis}
          WHERE run = ${id} AND kind = 'needs' AND dismissed_at IS NULL
        `;

        const [dismissed] = yield* selectRuns(sql`
          UPDATE runs SET attention = 0 WHERE id = ${id} RETURNING *
        `).pipe(Effect.mapError(storeError));

        if (dismissed === undefined)
          return yield* Effect.die(
            new Error("The dismissed run wasn't returned"),
          );

        return dismissed;
      },
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(storeError(cause))),
    );

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

    const recordEvent = Effect.fn("Store.recordEvent")(function* (
      event: Domain.GitHubEvent,
    ) {
      const rows = yield* sql`
        INSERT INTO github_events ${sql.insert({
          delivery: event.delivery,
          event: event.event,
          action: event.action,
          repo: event.repo,
          body: JSON.stringify(event),
          at: event.at,
          receivedAt: yield* Clock.currentTimeMillis,
        })}
        ON CONFLICT (delivery) DO NOTHING
        RETURNING delivery
      `;

      return rows.length > 0;
    }, Effect.mapError(storeError));

    const events = Effect.fn("Store.events")(function* (since: number) {
      const rows = yield* sql<{ body: string }>`
        SELECT body FROM github_events
        WHERE received_at >= ${since}
        ORDER BY received_at DESC
      `;

      return yield* decodeEvents(rows.map((row) => row.body));
    }, Effect.mapError(storeError));

    const pruneEvents = Effect.fn("Store.pruneEvents")(function* (
      before: number,
    ) {
      const rows = yield* sql`
        DELETE FROM github_events WHERE received_at < ${before}
        RETURNING delivery
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

    const repoColumns = sql.literal(
      "repo, jobs, added_at, title, name, named_by",
    );

    const repos = Effect.fn("Store.repos")(function* () {
      return yield* selectRepos(sql`
        SELECT ${repoColumns} FROM repos ORDER BY repo COLLATE NOCASE
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
        RETURNING ${repoColumns}
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

    const setNames = Effect.fn("Store.setNames")(
      function* (names: ReadonlyArray<Api.RepoLabel>) {
        for (const { repo, name } of names) {
          yield* sql`
            UPDATE repos SET name = ${name}, named_by = 'worker'
            WHERE repo = ${repo} AND (named_by IS NULL OR named_by = 'worker')
          `;
        }
      },
      sql.withTransaction,
      Effect.mapError(storeError),
    );

    const rename = Effect.fn("Store.rename")(function* (
      repo: string,
      name: string | null,
    ) {
      const [renamed] = yield* selectRepos(sql`
        UPDATE repos SET name = ${name}, named_by = ${name === null ? null : "you"}
        WHERE repo = ${repo}
        RETURNING ${repoColumns}
      `);

      return Option.fromUndefinedOr(renamed);
    }, Effect.mapError(storeError));

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
      machineRuns,
      claim,
      heartbeat,
      appendLog,
      finish,
      updateHeal,
      shareSession,
      session,
      report,
      activity,
      healsSince,
      heals,
      park,
      unpark,
      parked,
      wait,
      stopWaiting,
      waiting,
      pause,
      resume,
      hold,
      takeHeld,
      setAgents,
      agents,
      putSkillChange,
      skillChange,
      skillChanges,
      setSkillChangeState,
      putSkills,
      skillsPage,
      recordAttention,
      attention,
      looked,
      hideAttention,
      markAttentionRead,
      createGroup,
      updateGroup,
      deleteGroup,
      linkAttention,
      addWait,
      removeWait,
      commentAttention,
      addRule,
      removeRule,
      recordContext,
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
      dismissRun,
      known,
      seen,
      needs,
      settle,
      pruneInbox,
      recordEvent,
      events,
      pruneEvents,
      repos,
      track,
      untrack,
      setTitles,
      setNames,
      rename,
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
