/**
 * The MCP server: the CLI's operations as tools on stdio, built from the same
 * `Jobs` service and server client so an agent sees what a person does.
 */
import { BunStdio } from "@effect/platform-bun";
import { Api, Client, Domain } from "@upkeep/api";
import { version } from "@upkeep/server";
import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { adminClientFromEnv } from "./clients";
import { Job, Jobs, JobsError } from "./jobs/Jobs";

/** Why a tool that talks to the server failed. */
export class UpkeepError extends Schema.TaggedError<UpkeepError>()(
  "UpkeepError",
  { message: Schema.String },
) {}

/** The worker and session a run's agent worked in, to change its schedules there. */
export const runSession = Effect.fn("runSession")(function* (run: string) {
  const client = yield* Client;
  const found = yield* client.runs.schedules({ params: { id: run } });

  if (found.worker === null || found.session === null) {
    return yield* Effect.fail(
      new UpkeepError({
        message: `Run ${run} had no agent session, so it has no schedules`,
      }),
    );
  }

  return { worker: found.worker, session: found.session };
});

// Failures go back to the client as the tool's result, so an agent can read
// them and carry on.
const Status = Tool.make("status", {
  description:
    "Upkeep's one status from the server in $UPKEEP_SERVER: its health, what needs you with the dashboard page for each, the parked jobs and the live workers",
  success: Domain.Status,
  failure: UpkeepError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const JobsTool = Tool.make("jobs", {
  description: "List the jobs upkeep runs",
  success: Schema.Struct({ jobs: Schema.Array(Job) }),
  failure: JobsError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Runs = Tool.make("runs", {
  description:
    "List runs on the server in $UPKEEP_SERVER, newest first, optionally of one job or in one state, or with open only the failures nothing has settled yet",
  parameters: Schema.Struct({
    job: Schema.optionalKey(Domain.JobId),
    state: Schema.optionalKey(Domain.RunState),
    open: Schema.optionalKey(Schema.Boolean),
    limit: Schema.optionalKey(Schema.Int),
  }),
  success: Schema.Struct({ runs: Schema.Array(Domain.Run) }),
  failure: UpkeepError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Log = Tool.make("log", {
  description: `A run's log, from after line \`after\` when it's given, up to ${Api.maxLogLines} lines at a time`,
  parameters: Schema.Struct({
    run: Schema.String,
    after: Schema.optionalKey(Schema.Int),
  }),
  success: Schema.Struct({
    run: Domain.Run,
    lines: Schema.Array(Domain.LogLine),
  }),
  failure: UpkeepError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Run = Tool.make("run", {
  description:
    "Queue a run of a job on the server. A run of the same job and release that's still waiting is returned instead of a second one. Give repo to work on only that tracked repository; a waiting run for it or for every repository is returned instead.",
  parameters: Schema.Struct({
    job: Domain.JobId,
    release: Schema.optionalKey(Domain.Release),
    repo: Schema.optionalKey(Domain.RepoName),
  }),
  success: Domain.Run,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Cancel = Tool.make("cancel", {
  description:
    "Cancel a run on the server. A queued run is dropped; a running one is marked cancelled and its worker stops it shortly.",
  parameters: Schema.Struct({ run: Schema.String }),
  success: Api.Cancelled,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

const Retry = Tool.make("retry", {
  description:
    "Run a finished run again: its job for the same release, or for a heal, the same heal, even when the job is parked. The old run is dismissed. Returns the new run.",
  parameters: Schema.Struct({ run: Schema.String }),
  success: Domain.Run,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

const Dismiss = Tool.make("dismiss", {
  description:
    "Clear what a run left for a person: it stops needing attention and its inbox entry is dismissed",
  parameters: Schema.Struct({ run: Schema.String }),
  success: Domain.Run,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Unpark = Tool.make("unpark", {
  description:
    "Let a parked job be queued again by its schedule, releases and heals",
  parameters: Schema.Struct({ job: Domain.JobId }),
  success: Schema.Struct({ job: Domain.JobId }),
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Pause = Tool.make("pause", {
  description:
    "Turn a job off without stopping the server or worker: nothing queues it by schedule, release or heal until it's resumed, though it can still be run by hand. Pause heal to stop every heal.",
  parameters: Schema.Struct({ job: Domain.JobId }),
  success: Schema.Struct({ job: Domain.JobId }),
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Resume = Tool.make("resume", {
  description: "Turn a paused job back on",
  parameters: Schema.Struct({ job: Domain.JobId }),
  success: Schema.Struct({ job: Domain.JobId }),
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Repos = Tool.make("repos", {
  description:
    "List the repositories the server tracks and the jobs each is opted into. A job that works on repositories leaves every other one alone.",
  success: Schema.Struct({ repos: Schema.Array(Domain.TrackedRepo) }),
  failure: UpkeepError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Track = Tool.make("track", {
  description:
    "Track a repository, or change the jobs it's opted into. Without jobs it's opted into every job that works on repositories.",
  parameters: Schema.Struct({
    repo: Domain.RepoName,
    jobs: Schema.optionalKey(Schema.Array(Domain.JobId)),
  }),
  success: Domain.TrackedRepo,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Rename = Tool.make("rename", {
  description:
    "Set the name a repository shows by in the dashboard, over its README title and any name a worker gives it. Leave name out to clear it.",
  parameters: Schema.Struct({
    repo: Domain.RepoName,
    name: Schema.optionalKey(Schema.String),
  }),
  success: Domain.TrackedRepo,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Untrack = Tool.make("untrack", {
  description: "Stop tracking a repository, so no job works on it",
  parameters: Schema.Struct({ repo: Domain.RepoName }),
  success: Schema.Struct({ repo: Domain.RepoName }),
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

const Activity = Tool.make("activity", {
  description:
    "What happened lately on the server: how runs ended, the commits they pushed, newest first, and the runs that need a person. `hours` defaults to 24.",
  parameters: Schema.Struct({ hours: Schema.optionalKey(Schema.Finite) }),
  success: Domain.Activity,
  failure: UpkeepError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Inbox = Tool.make("inbox", {
  description:
    "The inbox: each entry's ID, what it is, and whether it's worth reading or a version bump (routine), with placedBy saying whether Upkeep, a repository rule or a person put it there. An entry with `you` set is the person's own commits or release, left out of what's worth reading unless it holds a fix by Upkeep or was put there. `days` defaults to 7, up to 30.",
  parameters: Schema.Struct({ days: Schema.optionalKey(Schema.Finite) }),
  success: Domain.Inbox,
  failure: UpkeepError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const InboxMove = Tool.make("inbox_move", {
  description:
    "Move an inbox entry to the version bumps (routine true) or what's worth reading (routine false), or hand it back to Upkeep's call (routine null). The move holds for later versions of the same update or drift. Something that needs a person stays where it is.",
  parameters: Schema.Struct({
    entry: Schema.String,
    routine: Schema.NullOr(Schema.Boolean),
  }),
  success: Domain.Entry,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const InboxRules = Tool.make("inbox_rules", {
  description:
    "List the inbox's repository rules: every entry from the repository goes to the version bumps (routine) or to what's worth reading",
  success: Schema.Struct({ rules: Schema.Array(Domain.InboxRule) }),
  failure: UpkeepError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const InboxRule = Tool.make("inbox_rule", {
  description:
    "Put every inbox entry from a repository in the version bumps (routine true) or what's worth reading (routine false), or let Upkeep decide again (routine null). An entry moved in the dashboard stays where it was moved.",
  parameters: Schema.Struct({
    repo: Domain.RepoName,
    routine: Schema.NullOr(Schema.Boolean),
  }),
  success: Schema.Struct({
    repo: Domain.RepoName,
    routine: Schema.NullOr(Schema.Boolean),
  }),
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Schedules = Tool.make("schedules", {
  description:
    "The OpenCode schedules on the agent's session a run worked in, such as a heal's, and the worker that session is on. Both are null when the run had no agent.",
  parameters: Schema.Struct({ run: Schema.String }),
  success: Domain.RunSchedules,
  failure: UpkeepError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Schedule = Tool.make("schedule", {
  description:
    "Pause, resume or delete a schedule on the agent's session a run worked in. It's done on the session's worker by a command run, which is returned.",
  parameters: Schema.Struct({
    run: Schema.String,
    schedule: Schema.String,
    action: Schema.Literals(["pause", "resume", "delete"]),
  }),
  success: Domain.Run,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

const ScheduleAdd = Tool.make("schedule_add", {
  description:
    'Schedule a prompt in the agent\'s session a run worked in, on the session\'s worker by a command run, which is returned. `when` is as OpenCode takes it: `{ "in": "2 hours" }`, `{ "at": "2026-11-16T09:00" }`, `{ "every": "30 minutes" }` or `{ "cron": "0 9 * * *" }`. With `condition`, a shell command, it only wakes once that passes.',
  parameters: Schema.Struct({
    run: Schema.String,
    when: Domain.ScheduleWhen,
    prompt: Schema.String,
    name: Schema.optionalKey(Schema.String),
    condition: Schema.optionalKey(Schema.String),
  }),
  success: Domain.Run,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

const Notes = Tool.make("notes", {
  description:
    "The standing notes agents read, each scoped to a repository (owner/name), `upkeep` for Upkeep itself or `attention` for the attention agent. `run` is the agent run that wrote it, or null for the person; `stale` is an agent saying it may be out of date, which asks the person to keep or drop it. One past `expiresAt` is kept but no agent reads it. `scope` narrows the list to one.",
  parameters: Schema.Struct({ scope: Schema.optionalKey(Schema.String) }),
  success: Schema.Struct({ notes: Schema.Array(Domain.Note) }),
  failure: UpkeepError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const NoteAdd = Tool.make("note_add", {
  description:
    "Keep a note for the agents working on a repository (scope owner/name), on Upkeep (upkeep) or the attention agent (attention), such as what its checks need first. `expiresAt`, in milliseconds, is when agents stop reading it.",
  parameters: Schema.Struct({
    scope: Domain.NoteScope,
    text: Schema.String,
    expiresAt: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  }),
  success: Domain.Note,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

const NoteEdit = Tool.make("note_edit", {
  description:
    "Change a note's text or expiry (null for never), which also clears an out-of-date flag",
  parameters: Schema.Struct({
    note: Schema.String,
    text: Schema.optionalKey(Schema.String),
    expiresAt: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  }),
  success: Domain.Note,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const NoteDelete = Tool.make("note_delete", {
  description: "Delete a note, so no agent reads it",
  parameters: Schema.Struct({ note: Schema.String }),
  success: Schema.Struct({ note: Schema.String }),
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

const NoteStale = Tool.make("note_stale", {
  description:
    "Flag a note as out of date, and why, which asks the person whether to drop it. Agents keep reading it, with why, until they do.",
  parameters: Schema.Struct({ note: Schema.String, reason: Schema.String }),
  success: Domain.Note,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const NoteKeep = Tool.make("note_keep", {
  description: "Keep a note flagged as out of date, clearing the flag",
  parameters: Schema.Struct({ note: Schema.String }),
  success: Domain.Note,
  failure: UpkeepError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

/** Every operation an agent can call, shared by MCP and Code Mode. */
export const Tools = Toolkit.make(
  Status,
  JobsTool,
  Runs,
  Activity,
  Log,
  Run,
  Cancel,
  Retry,
  Dismiss,
  Unpark,
  Pause,
  Resume,
  Schedules,
  Schedule,
  ScheduleAdd,
  Repos,
  Track,
  Rename,
  Untrack,
  Inbox,
  InboxMove,
  InboxRules,
  InboxRule,
  Notes,
  NoteAdd,
  NoteEdit,
  NoteDelete,
  NoteStale,
  NoteKeep,
);

/** A repository's path parameters from `owner/name`. */
const repoParams = (repo: string) => {
  const [owner = "", name = ""] = repo.split("/");

  return { owner, name };
};

/** Call the server as the admin in the environment, failing with a readable error. */
const onServer = <A, E extends { readonly message: string }>(
  effect: Effect.Effect<A, E, Client>,
) =>
  effect.pipe(
    Effect.provide(adminClientFromEnv),
    Effect.mapError((error) => new UpkeepError({ message: error.message })),
  );

/** The handlers behind `Tools`. */
export const toolsLayer = Tools.toLayer(
  Effect.gen(function* () {
    const jobs = yield* Jobs;

    return {
      status: () => onServer(Client.use((client) => client.status.get())),
      jobs: () => Effect.map(jobs.list(), (list) => ({ jobs: list })),
      runs: (query: {
        readonly job?: string | undefined;
        readonly state?: Domain.RunState | undefined;
        readonly open?: boolean | undefined;
        readonly limit?: number | undefined;
      }) =>
        onServer(
          Client.use((client) =>
            client.runs
              .list({
                query: {
                  job: query.job,
                  state: query.state,
                  open: query.open === undefined ? undefined : `${query.open}`,
                  limit: query.limit,
                },
              })
              .pipe(Effect.map((runs) => ({ runs }))),
          ),
        ),
      activity: (input: { readonly hours?: number | undefined }) =>
        onServer(
          Client.use((client) =>
            client.activity.get({ query: { hours: input.hours } }),
          ),
        ),
      log: (input: {
        readonly run: string;
        readonly after?: number | undefined;
      }) =>
        onServer(
          Effect.gen(function* () {
            const client = yield* Client;
            const params = { id: input.run };

            return {
              run: yield* client.runs.get({ params }),
              lines: yield* client.runs.log({
                params,
                query: { after: input.after },
              }),
            };
          }),
        ),
      run: (input: {
        readonly job: string;
        readonly release?: Domain.Release | undefined;
        readonly repo?: string | undefined;
      }) =>
        onServer(
          Client.use((client) =>
            client.jobs.run({
              params: { id: input.job },
              payload: {
                ...(input.release !== undefined && { release: input.release }),
                ...(input.repo !== undefined && { repo: input.repo }),
              },
            }),
          ),
        ),
      cancel: (input: { readonly run: string }) =>
        onServer(
          Client.use((client) =>
            client.runs.cancel({ params: { id: input.run } }),
          ),
        ),
      retry: (input: { readonly run: string }) =>
        onServer(
          Client.use((client) =>
            client.runs.retry({ params: { id: input.run } }),
          ),
        ),
      dismiss: (input: { readonly run: string }) =>
        onServer(
          Client.use((client) =>
            client.runs.dismiss({ params: { id: input.run } }),
          ),
        ),
      unpark: (input: { readonly job: string }) =>
        onServer(
          Client.use((client) =>
            client.jobs
              .unpark({ params: { id: input.job } })
              .pipe(Effect.as({ job: input.job })),
          ),
        ),
      pause: (input: { readonly job: string }) =>
        onServer(
          Client.use((client) =>
            client.jobs
              .pause({ params: { id: input.job } })
              .pipe(Effect.as({ job: input.job })),
          ),
        ),
      resume: (input: { readonly job: string }) =>
        onServer(
          Client.use((client) =>
            client.jobs
              .resume({ params: { id: input.job } })
              .pipe(Effect.as({ job: input.job })),
          ),
        ),
      repos: () =>
        onServer(
          Client.use((client) =>
            client.repos.list().pipe(Effect.map((repos) => ({ repos }))),
          ),
        ),
      schedules: (input: { readonly run: string }) =>
        onServer(
          Client.use((client) =>
            client.runs.schedules({ params: { id: input.run } }),
          ),
        ),
      schedule: (input: {
        readonly run: string;
        readonly schedule: string;
        readonly action: "pause" | "resume" | "delete";
      }) =>
        onServer(
          Effect.gen(function* () {
            const client = yield* Client;
            const target = yield* runSession(input.run);

            return yield* client.attention.command({
              payload: {
                kind: `schedule-${input.action}`,
                ...target,
                schedule: input.schedule,
              },
            });
          }),
        ),
      schedule_add: (input: {
        readonly run: string;
        readonly when: Domain.ScheduleWhen;
        readonly prompt: string;
        readonly name?: string | undefined;
        readonly condition?: string | undefined;
      }) =>
        onServer(
          Effect.gen(function* () {
            const client = yield* Client;
            const target = yield* runSession(input.run);

            return yield* client.attention.command({
              payload: {
                kind: "schedule-add",
                ...target,
                when: input.when,
                prompt: input.prompt,
                ...(input.name !== undefined && { name: input.name }),
                ...(input.condition !== undefined && {
                  condition: input.condition,
                }),
              },
            });
          }),
        ),
      track: (input: {
        readonly repo: string;
        readonly jobs?: ReadonlyArray<string> | undefined;
      }) =>
        onServer(
          Client.use((client) =>
            client.repos.track({
              params: repoParams(input.repo),
              payload: input.jobs === undefined ? {} : { jobs: input.jobs },
            }),
          ),
        ),
      rename: (input: {
        readonly repo: string;
        readonly name?: string | undefined;
      }) => {
        const typed = input.name?.trim() ?? "";

        return onServer(
          Client.use((client) =>
            client.repos.rename({
              params: repoParams(input.repo),
              payload: { name: typed === "" ? null : typed },
            }),
          ),
        );
      },
      untrack: (input: { readonly repo: string }) =>
        onServer(
          Client.use((client) =>
            client.repos
              .untrack({ params: repoParams(input.repo) })
              .pipe(Effect.as({ repo: input.repo })),
          ),
        ),
      inbox: (input: { readonly days?: number | undefined }) =>
        onServer(
          Client.use((client) =>
            client.inbox.get({ query: { days: input.days } }),
          ),
        ),
      inbox_move: (input: {
        readonly entry: string;
        readonly routine: boolean | null;
      }) =>
        onServer(
          Client.use((client) =>
            client.inbox.place({
              params: { id: input.entry },
              payload: { routine: input.routine },
            }),
          ),
        ),
      inbox_rules: () =>
        onServer(
          Client.use((client) =>
            client.inbox.rules().pipe(Effect.map((rules) => ({ rules }))),
          ),
        ),
      inbox_rule: (input: {
        readonly repo: string;
        readonly routine: boolean | null;
      }) =>
        onServer(
          Client.use((client) =>
            client.inbox.rule({ payload: input }).pipe(Effect.as(input)),
          ),
        ),
      notes: (input: { readonly scope?: string | undefined }) =>
        onServer(
          Client.use((client) =>
            client.notes.list().pipe(
              Effect.map((all) => ({
                notes: all.filter(
                  (note) =>
                    input.scope === undefined ||
                    note.scope.toLowerCase() === input.scope.toLowerCase(),
                ),
              })),
            ),
          ),
        ),
      note_add: (payload: {
        readonly scope: string;
        readonly text: string;
        readonly expiresAt?: number | null;
      }) => onServer(Client.use((client) => client.notes.add({ payload }))),
      note_edit: ({
        note,
        ...payload
      }: {
        readonly note: string;
        readonly text?: string;
        readonly expiresAt?: number | null;
      }) =>
        onServer(
          Client.use((client) =>
            client.notes.edit({ params: { id: note }, payload }),
          ),
        ),
      note_delete: (input: { readonly note: string }) =>
        onServer(
          Client.use((client) =>
            client.notes
              .remove({ params: { id: input.note } })
              .pipe(Effect.as(input)),
          ),
        ),
      note_stale: (input: { readonly note: string; readonly reason: string }) =>
        onServer(
          Client.use((client) =>
            client.notes.stale({
              params: { id: input.note },
              payload: { reason: input.reason },
            }),
          ),
        ),
      note_keep: (input: { readonly note: string }) =>
        onServer(
          Client.use((client) =>
            client.notes.keep({ params: { id: input.note } }),
          ),
        ),
    };
  }),
);

/** Serve the operations over MCP on stdio until the client disconnects. */
export const serveMcp = () =>
  McpServer.toolkit(Tools).pipe(
    Layer.provide(toolsLayer),
    Layer.provide(
      McpServer.layerStdio({
        name: "upkeep",
        version,
        protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25],
      }),
    ),
    Layer.provide(BunStdio.layer),
    Layer.launch,
    Effect.withSpan("serveMcp"),
  );
