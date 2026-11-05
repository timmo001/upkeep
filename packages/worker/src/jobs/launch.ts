/**
 * Start an agent from the Attention page: gather where an item, or a group's
 * items, stand (signals, description, unresolved threads with their file and
 * line, failing checks with their log tails, linked issues, the rest of the
 * group, the context agent's notes, outside waits and your comments) into a
 * brief, then run the worker's `attention.launch` command in the checkout,
 * which opens the agent with it. The agent is yours to steer; Upkeep only
 * starts it.
 */
import { Graphql, Repository, Workflow } from "@timmo001/effect-gh";
import { Domain } from "@upkeep/api";
import { Config, Effect, FileSystem, Path, Schema } from "effect";
import { reason } from "../Failure";
import { Reporter, summary } from "../Reporter";
import * as RunLog from "../RunLog";
import * as Settings from "../settings";
import { run } from "./bump";

class LaunchFailed extends Schema.TaggedError<LaunchFailed>()("LaunchFailed", {
  message: Schema.String,
}) {}

/** How much of a description or comment goes in the brief. */
const maxText = 3000;

/** How many failing checks have their log read. */
const maxLogs = 2;

/** How many lines of each failing check's log go in. */
const logLines = 40;

const clip = (text: string) =>
  text.length > maxText ? `${text.slice(0, maxText)}…` : text;

const Comment = Schema.Struct({
  author: Schema.NullOr(
    Schema.Struct({ __typename: Schema.String, login: Schema.String }),
  ),
  body: Schema.String,
});

/** A person's comment, without a bot's status reports or hidden markup. */
const human = (comment: typeof Comment.Type | null) =>
  comment === null || comment.author?.__typename === "Bot"
    ? []
    : [
        `${comment.author?.login ?? "someone"}: ${clip(comment.body.replaceAll(/<!--[\s\S]*?-->/g, "").trim())}`,
      ];

const Context = Schema.Struct({
  __typename: Schema.String,
  name: Schema.optionalKey(Schema.String),
  conclusion: Schema.optionalKey(Schema.NullOr(Schema.String)),
  detailsUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  checkSuite: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        workflowRun: Schema.NullOr(Schema.Struct({ databaseId: Schema.Int })),
      }),
    ),
  ),
  context: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
  targetUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const Detail = Schema.Struct({
  resource: Schema.NullOr(
    Schema.Struct({
      body: Schema.optionalKey(Schema.String),
      baseRefName: Schema.optionalKey(Schema.String),
      headRefName: Schema.optionalKey(Schema.String),
      mergeable: Schema.optionalKey(Schema.String),
      reviewThreads: Schema.optionalKey(
        Schema.Struct({
          nodes: Schema.Array(
            Schema.NullOr(
              Schema.Struct({
                isResolved: Schema.Boolean,
                path: Schema.String,
                line: Schema.NullOr(Schema.Int),
                comments: Schema.Struct({
                  nodes: Schema.Array(Schema.NullOr(Comment)),
                }),
              }),
            ),
          ),
        }),
      ),
      commits: Schema.optionalKey(
        Schema.Struct({
          nodes: Schema.Array(
            Schema.NullOr(
              Schema.Struct({
                commit: Schema.Struct({
                  statusCheckRollup: Schema.NullOr(
                    Schema.Struct({
                      contexts: Schema.Struct({
                        nodes: Schema.Array(Schema.NullOr(Context)),
                      }),
                    }),
                  ),
                }),
              }),
            ),
          ),
        }),
      ),
      closingIssuesReferences: Schema.optionalKey(
        Schema.Struct({
          nodes: Schema.Array(
            Schema.NullOr(
              Schema.Struct({
                url: Schema.String,
                title: Schema.String,
                state: Schema.String,
              }),
            ),
          ),
        }),
      ),
      comments: Schema.optionalKey(
        Schema.Struct({ nodes: Schema.Array(Schema.NullOr(Comment)) }),
      ),
    }),
  ),
});

type Detail = typeof Detail.Type;

const detailDocument = `
query ($url: URI!) {
  resource(url: $url) {
    ... on Issue {
      body
      comments(last: 5) { nodes { author { __typename login } body } }
    }
    ... on PullRequest {
      body baseRefName headRefName mergeable
      comments(last: 5) { nodes { author { __typename login } body } }
      reviewThreads(first: 50) {
        nodes {
          isResolved path line
          comments(last: 1) { nodes { author { __typename login } body } }
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name conclusion detailsUrl
                    checkSuite { workflowRun { databaseId } }
                  }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
      closingIssuesReferences(first: 10) { nodes { url title state } }
    }
  }
}
`;

const failing = new Set([
  "FAILURE",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
  "ERROR",
]);

/** The end of a failed workflow run's failed steps, or null when unreadable. */
const logTail = (repo: string, id: number) =>
  Workflow.logs({ repo, runId: id, failedOnly: true }).pipe(
    // Each line is job, step and text, tab-separated; the text is enough
    Effect.map((log) =>
      log
        .trimEnd()
        .split("\n")
        .slice(-logLines)
        .map((line) => line.split("\t").slice(2).join("\t") || line)
        .join("\n"),
    ),
    Effect.catchCause((cause) =>
      RunLog.warn(`Couldn't read run ${id}'s log: ${reason(cause)}`).pipe(
        Effect.as(null),
      ),
    ),
  );

/** One item's part of the brief. */
const describe = Effect.fnUntraced(function* (
  item: Domain.AttentionItem,
  page: Domain.Attention,
) {
  const { resource } = yield* Graphql.query(
    detailDocument,
    { url: item.url },
    Detail,
  ).pipe(
    Effect.catchCause((cause) =>
      RunLog.warn(`Couldn't read ${item.url}: ${reason(cause)}`).pipe(
        Effect.as<Detail>({ resource: null }),
      ),
    ),
  );

  const threads = (resource?.reviewThreads?.nodes ?? []).flatMap((thread) =>
    thread === null || thread.isResolved ? [] : [thread],
  );

  const checks = (resource?.commits?.nodes ?? []).flatMap(
    (node) =>
      node?.commit.statusCheckRollup?.contexts.nodes.flatMap((check) =>
        check !== null && failing.has(check.conclusion ?? check.state ?? "")
          ? [check]
          : [],
      ) ?? [],
  );

  const runs = [
    ...new Set(
      checks.flatMap(
        (check) => check.checkSuite?.workflowRun?.databaseId ?? [],
      ),
    ),
  ].slice(0, maxLogs);

  const logs = yield* Effect.forEach(runs, (id) =>
    logTail(item.repo, id).pipe(Effect.map((log) => [id, log] as const)),
  );

  const linked = (resource?.closingIssuesReferences?.nodes ?? []).flatMap(
    (issue) => (issue === null ? [] : [issue]),
  );

  const comments = page.comments.filter((comment) => comment.url === item.url);

  const said = (resource?.comments?.nodes ?? []).flatMap(human);

  return [
    `## ${item.title}`,
    "",
    `${item.url}: ${item.kind === "pull" ? "pull request" : "issue"} on ${item.repo}${item.author === null ? "" : ` by ${item.author}`}, in ${item.section} on the Attention page.`,
    `Signals: ${item.signals.map((signal) => `${Domain.signalLabel(signal.kind)}${signal.detail === null ? "" : ` (${signal.detail})`}`).join(", ") || "none"}. Labels: ${item.labels.join(", ") || "none"}.`,
    ...(resource?.headRefName === undefined
      ? []
      : [
          `Branch ${resource.headRefName} into ${resource.baseRefName ?? "the default branch"}${resource.mergeable === "CONFLICTING" ? `, with conflicts: merge origin/${resource.baseRefName ?? "the base"} to see which files` : ""}.`,
        ]),
    ...(item.note === null ? [] : [`Context note: ${item.note.text}`]),
    ...comments.map(
      (comment) =>
        `You told the context agent: ${comment.text}${comment.outcome === null ? "" : ` (it said: ${comment.outcome})`}`,
    ),
    "",
    "### Description",
    "",
    resource?.body === undefined || resource.body.trim() === ""
      ? "(none)"
      : clip(resource.body.trim()),
    ...(threads.length === 0
      ? []
      : [
          "",
          "### Unresolved review threads",
          "",
          ...threads.map((thread) => {
            // A review bot's thread still counts; only its markup goes
            const [last] = thread.comments.nodes.flatMap((comment) =>
              comment === null
                ? []
                : [
                    `${comment.author?.login ?? "someone"}: ${clip(comment.body.replaceAll(/<!--[\s\S]*?-->/g, "").trim())}`,
                  ],
            );

            return `- ${thread.path}${thread.line === null ? "" : `:${thread.line}`}${last === undefined ? "" : `, ${last}`}`;
          }),
        ]),
    ...(checks.length === 0
      ? []
      : [
          "",
          "### Failing checks",
          "",
          ...checks.map(
            (check) =>
              `- ${check.name ?? check.context ?? "a check"}${(check.detailsUrl ?? check.targetUrl) ? `: ${check.detailsUrl ?? check.targetUrl}` : ""}`,
          ),
          ...logs.flatMap(([id, log]) =>
            log === null
              ? []
              : [
                  "",
                  `The end of run ${id}'s failed steps:`,
                  "",
                  "```",
                  log,
                  "```",
                ],
          ),
        ]),
    ...(linked.length === 0
      ? []
      : [
          "",
          "### Issues it closes",
          "",
          ...linked.map(
            (issue) =>
              `- ${issue.url} (${issue.state.toLowerCase()}): ${issue.title}`,
          ),
        ]),
    ...(said.length === 0
      ? []
      : ["", "### Latest comments", "", ...said.map((line) => `- ${line}`)]),
  ].join("\n");
});

/** The brief: what to look at, then each item's part, then the group's. */
const briefOf = Effect.fnUntraced(function* (
  page: Domain.Attention,
  items: ReadonlyArray<Domain.AttentionItem>,
  group: Domain.AttentionGroup | undefined,
  prompt: string | null,
) {
  const titles = new Map(page.items.map((item) => [item.url, item]));

  const parts = yield* Effect.forEach(items, (item) => describe(item, page), {
    concurrency: 3,
  });

  const rest =
    group?.items.flatMap((link) =>
      items.some((item) => item.url === link.url) ? [] : [link.url],
    ) ?? [];

  return [
    `# ${group === undefined ? (items[0]?.title ?? "Attention") : group.name}`,
    "",
    prompt ??
      "Look at where this stands and what it needs from me next, then tell me what you'd do before changing anything.",
    "",
    "This brief comes from Upkeep's Attention page. For a pull request, check out its branch with `gh pr checkout` first.",
    "",
    ...(group === undefined
      ? []
      : [
          `It's the group ${group.name} (focus ${group.focus}).`,
          ...(group.followUp === null
            ? []
            : [`Follow-up: ${group.followUp.text}`]),
          ...group.waits.map(
            (wait) =>
              `Waits on: ${wait.text}${wait.url === null ? "" : ` (${wait.url})`}`,
          ),
          ...page.comments.flatMap((comment) =>
            comment.group === group.id
              ? [`You told the context agent: ${comment.text}`]
              : [],
          ),
          ...(rest.length === 0
            ? []
            : [
                "",
                "The rest of the group:",
                ...rest.map((url) => {
                  const other = titles.get(url);

                  return other === undefined
                    ? `- ${url} (no longer open)`
                    : `- ${url} [${other.section}] ${other.title}`;
                }),
              ]),
          "",
        ]),
    ...parts.flatMap((part) => [part, ""]),
  ].join("\n");
});

const cacheRoot = Config.String("XDG_CACHE_HOME").pipe(
  Config.orElse(() =>
    Config.String("HOME").pipe(Config.map((home) => `${home}/.cache`)),
  ),
  Config.map((root) => `${root}/upkeep`),
);

/**
 * Where the agent works: your checkout from the `directory` pattern, or a
 * clone in the cache, which is left as it is once there so work in it isn't
 * lost.
 */
const directoryFor = Effect.fnUntraced(function* (
  repo: string,
  pattern: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const [owner = "", name = ""] = repo.split("/");
  const home = yield* Config.String("HOME").pipe(Config.withDefault(""));

  if (pattern !== undefined) {
    const mine = pattern
      .replace(/^~(?=\/)/, home)
      .replaceAll("{owner}", owner)
      .replaceAll("{name}", name);

    if (yield* fs.exists(mine)) return mine;

    yield* RunLog.info(`There's no checkout at ${mine}, so using the cache`);
  }

  const directory = `${yield* cacheRoot}/agents/${repo}`;

  if (!(yield* fs.exists(directory))) {
    yield* fs.makeDirectory(`${yield* cacheRoot}/agents/${owner}`, {
      recursive: true,
    });
    yield* Repository.clone({
      repository: repo,
      directory,
      gitArgs: ["--quiet", "--filter=blob:none"],
    });
  }

  return directory;
});

export const launch = Effect.fnUntraced(function* (
  command: Extract<Domain.Command, { readonly kind: "start-agent" }>,
) {
  const settings = yield* Settings.load();
  const setup = settings.attention?.launch;

  if (setup === undefined)
    return yield* new LaunchFailed({
      message: "This worker has no attention.launch in its settings",
    });

  const reporter = yield* Reporter;
  const page = yield* reporter.attentionPage();

  const group =
    command.group === null
      ? undefined
      : page.groups.find((each) => each.id === command.group);

  const urls =
    command.url === null
      ? (group?.items.flatMap((link) => (link.suggested ? [] : [link.url])) ??
        [])
      : [command.url];

  const items = page.items.filter((item) => urls.includes(item.url));
  const [first] = items;

  if (first === undefined)
    return yield* new LaunchFailed({
      message: "Nothing to start an agent on: it's no longer on the page",
    });

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const brief = yield* briefOf(page, items, group, command.prompt);
  const briefs = `${yield* cacheRoot}/briefs`;
  const file = path.join(briefs, `${Date.now()}.md`);

  yield* fs.makeDirectory(briefs, { recursive: true });
  yield* fs.writeFileString(file, brief);

  const directory = yield* directoryFor(first.repo, setup.directory);
  const title = group?.name ?? first.title;

  const fill = (arg: string) =>
    arg
      .replaceAll("{brief}", file)
      .replaceAll("{directory}", directory)
      .replaceAll("{repo}", first.repo)
      .replaceAll("{name}", first.repo.split("/").at(-1) ?? first.repo)
      .replaceAll("{title}", title);

  const [program = "", ...args] = setup.command.map(fill);

  yield* RunLog.info(
    `Wrote the brief to ${file}, starting the agent in ${directory}`,
  );
  yield* run(program, args, { cwd: directory, trusted: "" });
  yield* summary(`Started an agent on ${title} in ${directory}`);
});
