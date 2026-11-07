/**
 * Where a job sends what it found and what it did: to the server for a run a
 * worker took, so it can queue the jobs that follow and keep a heal's record,
 * or nowhere for one run by hand with `upkeep run --local`.
 */
import { Api, Client, Domain } from "@upkeep/api";
import { Array as Arr, Clock, Context, Effect, Layer } from "effect";
import * as RunLog from "./RunLog";

export class Reporter extends Context.Service<
  Reporter,
  {
    /** The latest release of each repository. Returns the runs it queued. */
    readonly releases: (
      releases: ReadonlyArray<Domain.Release>,
    ) => Effect.Effect<ReadonlyArray<Domain.Run>, unknown>;
    /**
     * For a heal: its record, the run it heals with the end of its log, and
     * what triage knows of failures like it.
     */
    readonly healing: () => Effect.Effect<Healing, unknown>;
    /** For a heal: queue the failed job again, unless it's parked. */
    readonly retry: () => Effect.Effect<Domain.Run | null, unknown>;
    /**
     * Park a job until someone unparks it, or until `issue`, its triage
     * issue, is resolved.
     */
    readonly park: (
      job: string,
      reason: string,
      issue: string | null,
    ) => Effect.Effect<void, unknown>;
    /** For a heal: fill in its record. */
    readonly heal: (update: Api.HealUpdate) => Effect.Effect<void, unknown>;
    /** For a heal: share the session its agent left, so any worker can open it. */
    readonly shareSession: (
      shared: Api.SessionExport,
    ) => Effect.Effect<void, unknown>;
    /** A session another worker shared, or null when none did. */
    readonly session: (
      id: string,
    ) => Effect.Effect<Api.SessionExport | null, unknown>;
    /** The heals queued since `since`, newest first. */
    readonly heals: (
      since: number,
    ) => Effect.Effect<ReadonlyArray<Domain.Run>, unknown>;
    /**
     * The repositories the server tracks for a job, the only ones it works
     * on, or every tracked repository without one.
     */
    readonly repos: (
      job?: Domain.JobId,
    ) => Effect.Effect<ReadonlyArray<string>, unknown>;
    /** The inbox, as the dashboard shows it, for the summary job. */
    readonly inbox: () => Effect.Effect<Domain.Inbox, unknown>;
    /** Which of these commits the inbox already has. */
    readonly known: (
      commits: ReadonlyArray<Api.CommitRef>,
    ) => Effect.Effect<ReadonlyArray<Api.CommitRef>, unknown>;
    /** Record tracked repositories' titles. */
    readonly titles: (
      titles: ReadonlyArray<Api.RepoTitle>,
    ) => Effect.Effect<void, unknown>;
    /** Record names to show tracked repositories by, from the `names` setting. */
    readonly names: (
      names: ReadonlyArray<Api.RepoLabel>,
    ) => Effect.Effect<void, unknown>;
    /** Add commits found outside Upkeep's runs to the inbox. Returns how many were new. */
    readonly seen: (
      commits: ReadonlyArray<Domain.Change>,
    ) => Effect.Effect<number, unknown>;
    /** Send what the attention job found. */
    readonly attention: (snapshot: Api.AttentionSnapshot) => Effect.Effect<
      {
        readonly added: number;
        readonly changed: number;
        readonly gone: number;
      },
      unknown
    >;
    /** The Attention page as the dashboard reads it, for the context agent. */
    readonly attentionPage: () => Effect.Effect<Domain.Attention, unknown>;
    /** Send what the context agent made of what it was given. */
    readonly attentionContext: (
      context: Api.AttentionContext,
    ) => Effect.Effect<void, unknown>;
    /**
     * Report the run's summary, a commit it pushed, or that it needs a
     * person. A report that can't be sent is logged rather than failing the run.
     */
    readonly report: (report: Api.RunReport) => Effect.Effect<void>;
    /** The held skill changes still open, and those that ended lately. */
    readonly skillChanges: () => Effect.Effect<
      ReadonlyArray<Domain.SkillChange>,
      unknown
    >;
    readonly skillChange: (
      id: string,
    ) => Effect.Effect<Domain.SkillChange, unknown>;
    /** Keep a skill change on the server, as this worker's. */
    readonly putSkillChange: (
      id: string,
      change: Api.SkillChangeInput,
    ) => Effect.Effect<void, unknown>;
    readonly skillChangeState: (
      id: string,
      update: Api.SkillChangeStateUpdate,
    ) => Effect.Effect<void, unknown>;
    /** Queue a `skill-*` command as a run of the skill-change job. */
    readonly skillCommand: (
      command: Domain.Command,
    ) => Effect.Effect<Domain.Run, unknown>;
    /** Keep a repository's skills on the server, for the Skills page. */
    readonly putSkills: (
      snapshot: Domain.SkillsSnapshot,
    ) => Effect.Effect<void, unknown>;
  }
>()("@upkeep/worker/Reporter") {
  /**
   * Send findings to the server, for the run `runId`. With `repo`, the run
   * only works on that repository.
   */
  static readonly remote = (runId: string, repo: string | null = null) =>
    Layer.effect(
      Reporter,
      Effect.gen(function* () {
        const client = yield* Client;
        const params = { id: runId };

        return Reporter.of({
          releases: Effect.fnUntraced(function* (releases) {
            const queued: Array<Domain.Run> = [];

            for (const batch of Arr.chunksOf(releases, Api.maxReleases)) {
              const result = yield* client.work.releases({
                payload: { releases: batch },
              });

              queued.push(...result.queued);
            }

            return queued;
          }),
          healing: () => client.work.healing({ params }),
          retry: () =>
            client.work.retry({ params }).pipe(Effect.map(({ run }) => run)),
          park: (job, reason, issue) =>
            client.work.park({
              params: { job },
              payload: issue === null ? { reason } : { reason, issue },
            }),
          heal: (update) => client.work.heal({ params, payload: update }),
          shareSession: (shared) =>
            client.work.shareSession({ params, payload: shared }),
          session: (id) =>
            client.work
              .session({ params: { id } })
              .pipe(
                Effect.catchTag("SessionNotFound", () => Effect.succeed(null)),
              ),
          heals: (since) => client.work.heals({ query: { since } }),
          repos: narrowTo(repo, (job) =>
            client.work.repos({ query: job === undefined ? {} : { job } }),
          ),
          inbox: () => client.work.inbox(),
          known: Effect.fnUntraced(function* (commits) {
            const known: Array<Api.CommitRef> = [];

            for (const batch of Arr.chunksOf(commits, Api.maxCommits)) {
              const result = yield* client.work.known({
                payload: { commits: batch },
              });

              known.push(...result.known);
            }

            return known;
          }),
          titles: Effect.fnUntraced(function* (titles) {
            for (const batch of Arr.chunksOf(titles, Api.maxCommits)) {
              yield* client.work.titles({ payload: { titles: batch } });
            }
          }),
          names: Effect.fnUntraced(function* (names) {
            for (const batch of Arr.chunksOf(names, Api.maxCommits)) {
              yield* client.work.names({ payload: { names: batch } });
            }
          }),
          seen: Effect.fnUntraced(function* (commits) {
            let added = 0;

            for (const batch of Arr.chunksOf(commits, Api.maxCommits)) {
              const result = yield* client.work.seen({
                payload: { commits: batch },
              });

              added += result.added;
            }

            return added;
          }),
          attention: (snapshot) => client.work.attention({ payload: snapshot }),
          attentionPage: () => client.work.attentionPage(),
          attentionContext: (context) =>
            client.work.attentionContext({ payload: context }),
          report: (report) =>
            client.work
              .report({ params, payload: report })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Couldn't report on the run", cause),
                ),
              ),
          skillChanges: () => client.work.skillChanges(),
          skillChange: (id) => client.work.skillChange({ params: { id } }),
          putSkillChange: (id, change) =>
            client.work.putSkillChange({ params: { id }, payload: change }),
          skillChangeState: (id, update) =>
            client.work.skillChangeState({ params: { id }, payload: update }),
          skillCommand: (command) =>
            client.work.skillCommand({ payload: command }),
          putSkills: (snapshot) => client.work.putSkills({ payload: snapshot }),
        });
      }),
    );

  /**
   * Queue and park nothing, for a run that only shows what it would do. A
   * heal needs the server's run, so it can't run here. The tracked
   * repositories come from `repos`, as an admin reads them.
   */
  static readonly local = (
    repos: (
      job?: Domain.JobId,
    ) => Effect.Effect<ReadonlyArray<string>, unknown>,
  ) =>
    Layer.succeed(
      Reporter,
      Reporter.of({
        releases: () => Effect.succeed([]),
        healing: () => Effect.fail("A heal only runs on a worker"),
        retry: () => Effect.succeed(null),
        park: (job, reason) =>
          RunLog.info(`Would park ${job}: ${reason}`).pipe(
            Effect.provide(RunLog.RunLog.console),
          ),
        heal: () => Effect.void,
        shareSession: () => Effect.void,
        session: () => Effect.succeed(null),
        heals: () => Effect.succeed([]),
        repos,
        inbox: () => Effect.fail("The summary reads the inbox on a worker"),
        known: () => Effect.succeed([]),
        titles: () => Effect.void,
        names: (names) =>
          RunLog.info(`Would name ${names.length} repositories`).pipe(
            Effect.provide(RunLog.RunLog.console),
          ),
        seen: (commits) =>
          RunLog.info(`Would add ${commits.length} commits to the inbox`).pipe(
            Effect.provide(RunLog.RunLog.console),
            Effect.as(commits.length),
          ),
        attention: (snapshot) =>
          RunLog.info(
            `Would send ${snapshot.items.length} attention items${snapshot.complete ? "" : ", not all of them"}`,
          ).pipe(
            Effect.provide(RunLog.RunLog.console),
            Effect.as({ added: 0, changed: 0, gone: 0 }),
          ),
        attentionPage: () =>
          Effect.fail("The context agent reads the page on a worker"),
        attentionContext: (context) =>
          RunLog.info(
            `Would send ${context.notes.length} notes, ${context.followUps.length} follow-ups and ${context.comments.length} answers`,
          ).pipe(Effect.provide(RunLog.RunLog.console)),
        report: () => Effect.void,
        skillChanges: () =>
          Effect.fail("Held skill changes are kept on the server"),
        skillChange: () => Effect.fail("Held skill changes are on the server"),
        putSkillChange: () =>
          Effect.fail("Held skill changes are kept on the server"),
        skillChangeState: () =>
          Effect.fail("Held skill changes are kept on the server"),
        skillCommand: (command) =>
          RunLog.info(`Would queue ${command.kind}`).pipe(
            Effect.provide(RunLog.RunLog.console),
            Effect.andThen(Effect.fail("Nothing is queued from a local run")),
          ),
        putSkills: (snapshot) =>
          RunLog.info(
            `Would send ${snapshot.skills.length} skills in ${snapshot.repo}`,
          ).pipe(Effect.provide(RunLog.RunLog.console)),
      }),
    );
}

/**
 * The tracked repositories `repos` reads, narrowed to `repo` when a run was
 * scoped to one, ignoring case as GitHub does. Every job that works on
 * repositories reads them through this, so the scope reaches each one.
 */
export const narrowTo =
  <E>(
    repo: string | null,
    repos: (job?: Domain.JobId) => Effect.Effect<ReadonlyArray<string>, E>,
  ) =>
  (job?: Domain.JobId) =>
    repo === null
      ? repos(job)
      : repos(job).pipe(
          Effect.map((all) =>
            all.filter((name) => name.toLowerCase() === repo.toLowerCase()),
          ),
        );

/** Repositories by name for a summary, or `none`. */
export const listed = (repos: ReadonlyArray<string>) =>
  repos.length === 0
    ? "none"
    : repos.map((repo) => repo.split("/").at(-1) ?? repo).join(", ");

/** Write the run's summary to its log and the run. */
export const summary = (message: string) =>
  RunLog.info(message).pipe(
    Effect.andThen(
      Reporter.use((reporter) => reporter.report({ summary: message })),
    ),
  );

/** Record a commit the run pushed. */
export const pushed = Effect.fnUntraced(function* (
  repo: string,
  sha: string,
  subject: string,
) {
  const reporter = yield* Reporter;

  yield* reporter.report({
    change: {
      repo,
      sha,
      subject,
      url: `https://github.com/${repo}/commit/${sha}`,
      at: yield* Clock.currentTimeMillis,
    },
  });
});

/** Mark the run as having left something for a person. */
export const attention = Reporter.use((reporter) =>
  reporter.report({ attention: true }),
);

/**
 * Whether a repository is tracked for a job, ignoring case as GitHub does.
 * Logs how many are, so a run that does nothing says why.
 */
export const trackedFor = Effect.fnUntraced(function* (job: Domain.JobId) {
  const reporter = yield* Reporter;
  const repos = yield* reporter.repos(job);
  const names = new Set(repos.map((repo) => repo.toLowerCase()));

  yield* RunLog.info(
    `${names.size} ${names.size === 1 ? "repository is" : "repositories are"} tracked for ${job}`,
  );

  return (repo: string) => names.has(repo.toLowerCase());
});

export interface Healing {
  readonly heal: Domain.Heal;
  readonly run: Domain.Run;
  readonly log: ReadonlyArray<Domain.LogLine>;
  readonly precedents: ReadonlyArray<Domain.Precedent>;
}
