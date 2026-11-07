/**
 * `upkeep-attention`: what needs you on GitHub, in place of a daily brief.
 * What moved since you last looked comes first, then pull requests and issues
 * by section: what needs you, what's blocked, what's going stale and what
 * waits on others, with the rest folded away under Watching. Groups of work,
 * from GitHub's links or made by hand, show as folding panels: pinned under Today,
 * in the section of their most urgent item, or folded away when parked, with
 * what each waits on outside GitHub. A filter splits
 * work from personal, defaulting by whether it's work time. Opening the page
 * notes the visit and queues a collection when the last one is old.
 */
import {
  phWarningCircle,
  phBell,
  phCheck,
  phCheckCircle,
  phClock,
  phX,
  phChatCircle,
  phTrash,
  phDotsThreeVertical,
  phEnvelopeOpen,
  phEyeSlash,
  phEye,
  phFolder,
  phFolderPlus,
  phFolderMinus,
  phPencilSimple,
  phPlus,
  phRecord,
  phArrowClockwise,
  phRobot,
  phRocketLaunch,
  phGitPullRequest,
  phArrowsLeftRight,
} from "./icons.ts";
import { Domain } from "@upkeep/api";
import { GwInput } from "@timmo001/groundwork-ui/gw-input.ts";
import { GwPopover } from "@timmo001/groundwork-ui/gw-popover.ts";
import { GwSegmented } from "@timmo001/groundwork-ui/gw-segmented.ts";
import { getStorage } from "@timmo001/groundwork-ui/storage.ts";
import type {
  TableColumn,
  TableRow,
} from "@timmo001/groundwork-ui/gw-table.ts";
import { Option, Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { always, AtomController, registry } from "./AtomController.ts";
import { plural } from "./entries.ts";
import { drawn, empty, externalLink, icon, shared, time, view } from "./ui.ts";
import { type CellContent, type CellSize, cell } from "./upkeep-cell.ts";
import {
  addRule,
  addWait,
  agents,
  attention,
  commentAttention,
  createGroup,
  deleteGroup,
  hideAttention,
  jobs,
  linkAttention,
  markNotificationRead,
  openAttention,
  removeRule,
  removeWait,
  repos,
  runHref,
  runs,
  startAgent,
  updateGroup,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/gw-button.ts";
import "@timmo001/groundwork-ui/gw-spinner.ts";
import "@timmo001/groundwork-ui/gw-card.ts";
import "@timmo001/groundwork-ui/gw-chip.ts";
import "@timmo001/groundwork-ui/gw-expansion.ts";
import "@timmo001/groundwork-ui/gw-menu-button.ts";
import "@timmo001/groundwork-ui/gw-page-header.ts";
import "@timmo001/groundwork-ui/gw-section-title.ts";
import "@timmo001/groundwork-ui/gw-table.ts";
import "@timmo001/groundwork-ui/layout.ts";

type Scope = "work" | "personal" | "all";

const scopes: ReadonlyArray<{ readonly value: Scope; readonly label: string }> =
  [
    { value: "work", label: "Work" },
    { value: "personal", label: "Personal" },
    { value: "all", label: "All" },
  ];

/** Where groups were kept folded before each panel kept its own state. */
const collapsedKey = "upkeep.attention.collapsed";

/** Where a group's panel keeps whether it's open. */
const groupKey = (id: string) => `upkeep.attention.group.${id}`;

/** Where a folded section's panel keeps whether it's open. */
const sectionKey = (id: string) => `upkeep.attention.section.${id}`;

/** Where Since you last looked keeps whether its full list shows. */
const sinceKey = "upkeep.attention.since";

const lastWorkerKey = "upkeep.attention.worker";

const decodeCollapsed = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

/** Moves the groups folded under the old shared key to their own keys, once. */
const migrateCollapsed = () => {
  const old = localStorage.getItem(collapsedKey);

  if (old === null) return;

  const store = getStorage();

  for (const id of Option.getOrElse(
    decodeCollapsed(old),
    (): ReadonlyArray<string> => [],
  )) {
    store.set(groupKey(id), false);
  }

  localStorage.removeItem(collapsedKey);
};

const isScope = (value: string): value is Scope =>
  scopes.some((scope) => scope.value === value);

/** The sections in the order they show, each with what it means. */
const sections: ReadonlyArray<{
  readonly id: Exclude<Domain.AttentionSection, "backlog" | "watching">;
  readonly heading: string;
  readonly description: string;
}> = [
  {
    id: "needs-you",
    heading: "Needs you",
    description:
      "Reviews asked of you, changes requested, replies, mentions, and yours ready to merge",
  },
  {
    id: "blocked",
    heading: "Blocked",
    description:
      "Your pull requests with failing checks, conflicts, or an Upkeep run waiting",
  },
  {
    id: "stale",
    heading: "Going stale",
    description:
      "Yours, where others took part, with no activity from anyone lately",
  },
  {
    id: "waiting",
    heading: "Waiting on others",
    description: "Yours, where others took part and the next move is theirs",
  },
];

/** The sections folded away, with what each means. */
const folded: ReadonlyArray<{
  readonly id: Extract<Domain.AttentionSection, "backlog" | "watching">;
  readonly heading: string;
  readonly description: string;
}> = [
  {
    id: "backlog",
    heading: "Your backlog",
    description: "Your drafts, and your issues nobody else has taken part in",
  },
  {
    id: "watching",
    heading: "Watching",
    description:
      "Open on tracked repositories or involving you, with nothing asked of you",
  },
];

const tones: Record<Domain.SignalKind, string> = {
  "review-requested": "accent",
  "changes-requested": "warning",
  unresolved: "warning",
  "new-comment": "accent",
  mentioned: "accent",
  "failing-checks": "danger",
  conflicts: "danger",
  "base-moved": "warning",
  upkeep: "warning",
  approved: "success",
  ready: "success",
  draft: "neutral",
  unread: "info",
};

const kindIcons: Record<Domain.AttentionKind, string> = {
  pull: phGitPullRequest,
  issue: phRecord,
  notification: phBell,
};

const focuses: ReadonlyArray<{
  readonly value: Domain.AttentionFocus;
  readonly label: string;
  readonly description: string;
}> = [
  { value: "today", label: "Today", description: "Pinned at the top" },
  {
    value: "watching",
    label: "Watching",
    description: "In the section of its most urgent item",
  },
  { value: "parked", label: "Parked", description: "Folded away at the end" },
];

const isFocus = (value: string): value is Domain.AttentionFocus =>
  focuses.some((focus) => focus.value === value);

/** Sections from most to least urgent, which a group takes the first of. */
const urgency: ReadonlyArray<Domain.AttentionSection> = [
  "needs-you",
  "blocked",
  "stale",
  "waiting",
  "backlog",
  "watching",
];

const decodeChoice = Schema.decodeUnknownOption(
  Schema.Struct({ value: Schema.String }),
);

/** The value a menu item chosen carries. */
const chosen = (event: Event) => {
  const detail: unknown = event instanceof CustomEvent ? event.detail : null;

  return Option.match(decodeChoice(detail), {
    onNone: () => "",
    onSome: ({ value }) => value,
  });
};

/** A table column's cell, drawn from the row's own record by its ID. */
const drawFrom =
  <T>(byId: ReadonlyMap<string, T>) =>
  (content: (each: T) => CellContent, size: CellSize) =>
  (row: TableRow) => {
    const each = byId.get(String(row.id));

    return cell(each === undefined ? "" : content(each), size);
  };

/** What moved on items, or their going, as a table of its own. */
const changeTable = (
  changes: ReadonlyArray<Domain.AttentionChange>,
  label: string,
) => {
  const draw = drawFrom(
    new Map(changes.map((change, index) => [String(index), change])),
  );

  const columns: TableColumn[] = [
    {
      id: "repo",
      header: "Repository",
      cell: draw((change) => change.repo, { width: "11rem" }),
    },
    {
      id: "title",
      header: "Item",
      wide: true,
      cell: draw((change) => externalLink(change.url, change.title), "fill"),
    },
    {
      id: "what",
      header: "What moved",
      sortable: false,
      cell: draw(
        (change) =>
          change.gone
            ? [html`<gw-chip size="xs" tone="success">Gone</gw-chip>`]
            : change.what.map(
                (what) => html`<gw-chip size="xs">${what}</gw-chip>`,
              ),
        { width: "12rem" },
      ),
    },
    {
      id: "at",
      header: "When",
      searchable: false,
      cell: draw((change) => time(change.at), { width: "7rem" }),
    },
  ];

  return html`<gw-table
    label=${label}
    contained
    row-key="id"
    sort="at"
    descending
    search-label="Search"
    .columns=${columns}
    .rows=${changes.map((change, index) => ({
      id: String(index),
      repo: change.repo,
      title: change.title,
      what: change.gone ? "Gone" : change.what.join(", "),
      at: change.at,
    }))}
  ></gw-table>`;
};

/** A group with the items it shows now, and the section it sits in. */
interface Block {
  readonly group: Domain.AttentionGroup;
  readonly items: ReadonlyArray<Domain.AttentionItem>;
  readonly section: Domain.AttentionSection;
}

const inScope = (work: boolean, scope: Scope) =>
  scope === "all" || (scope === "work") === work;

/** Where an item's status label puts it: most pressing first, none mid-way. */
const statusRank = (item: Domain.AttentionItem) => {
  const status = Domain.statusOf(item.labels);

  return status === null
    ? Domain.statusLabels.indexOf("blocked") - 0.5
    : Domain.statusLabels.indexOf(status);
};

/**
 * Most recent first, except stale items, which show the longest quiet first,
 * and the backlog, which goes by status label first.
 */
const order =
  (section: Domain.AttentionSection) =>
  (a: Domain.AttentionItem, b: Domain.AttentionItem) => {
    if (section === "stale") return a.activityAt - b.activityAt;

    if (section === "backlog") {
      return statusRank(a) - statusRank(b) || b.activityAt - a.activityAt;
    }

    return b.activityAt - a.activityAt;
  };

/** The shared type labels worth a chip, as they match without case. */
const typeLabels: ReadonlySet<string> = new Set([
  "bug",
  "bug fix",
  "feature",
  "enhancement",
  "refactor",
  "performance",
  "breaking change",
  "security",
]);

/** How each status label's chip reads at a glance. */
const statusTones: Record<Domain.StatusLabel, string> = {
  "needs decision": "accent",
  blocked: "danger",
  "in progress": "warning",
  ready: "success",
  planned: "neutral",
  "needs research": "neutral",
  "on hold": "neutral",
  future: "neutral",
};

/** How many links to what moved the Since you last looked line shows. */
const maxSummaryLinks = 5;

/** What an agent starts on: an item, by its URL, or a group. */
type About = { readonly url: string } | { readonly group: string };

const key = (about: About) =>
  "url" in about ? `url:${about.url}` : `group:${about.group}`;

/**
 * Upkeep's own repository, always offered as a place to start an agent, so
 * it can move or sort issues with Upkeep's tools at hand.
 */
const upkeepRepo = "timmo001/upkeep";

/** How long a finished agent start shows on its item. */
const startShownFor = 10 * 60_000;

/** How long a start waits for the server's answer before it's let go. */
const pendingFor = 30_000;

export class UpkeepAttention extends LitElement {
  static override styles = [
    shared,
    css`
      .when,
      .meta {
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }

      ul {
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .items li {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--gw-space-1) var(--gw-space-3);
        padding: var(--gw-space-3) 0;
      }

      .items li + li {
        border-top: 1px dashed var(--gw-color-border-quiet);
      }

      .items li > .icon {
        margin-top: 0.2em;
        color: var(--gw-color-text-secondary);
      }

      .items li.moved > .icon {
        color: var(--gw-color-accent);
      }

      .title {
        font-weight: var(--gw-font-weight-strong);
      }

      .since {
        display: flex;
        flex-wrap: wrap;
        gap: var(--gw-space-1) var(--gw-space-3);
        align-items: center;
        min-width: 0;
      }

      .since > * {
        flex: none;
      }

      /* The links take what room is left, cut off at the end, or a line of
         their own on a narrow screen rather than widening the page */
      .since > .since-links {
        position: relative;
        flex: 1 1 0;
        min-width: 10rem;
        overflow: hidden;
        font-size: var(--gw-font-size-s);
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .since-links > a + a {
        margin-inline-start: var(--gw-space-3);
      }

      .since + gw-table {
        margin-top: var(--gw-space-2);
      }

      gw-table {
        --gw-table-max-height: 24rem;
      }

      .body {
        display: flex;
        flex-direction: column;
        gap: var(--gw-space-1);
        min-width: 0;
      }

      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: var(--gw-space-2);
        align-items: center;
      }

      .description {
        margin: 0;
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }

      .gone {
        text-decoration: line-through;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--gw-space-1);
      }

      .context {
        display: flex;
        flex-wrap: wrap;
        gap: var(--gw-space-2);
        align-items: center;
        margin: 0;
        font-size: var(--gw-font-size-s);
      }

      .context > span {
        flex: 1 1 20ch;
        min-width: 0;
      }

      .context > .icon {
        color: var(--gw-color-text-secondary);
      }

      .context.failed > .icon {
        color: var(--gw-color-danger);
      }

      .pending {
        color: var(--gw-color-text-secondary);
      }

      .waits li {
        display: flex;
        gap: var(--gw-space-2);
        align-items: center;
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }

      /* The scope and Collect controls drop below the title when they don't
         fit beside it, rather than squeezing it */
      gw-page-header {
        flex-wrap: wrap;
      }
    `,
  ];

  readonly #attention = new AtomController(this, () => attention, always);

  readonly #jobs = new AtomController(this, () => jobs, always);

  /** The scope picked, or none to follow work time. */
  #scope: Scope | undefined;

  /** Every group, for each item's Group menu. */
  #groups: ReadonlyArray<Domain.AttentionGroup> = [];

  /** Your latest comments, shown on what each is about. */
  #comments: ReadonlyArray<Domain.AttentionComment> = [];

  #prompt: GwPopover | undefined;

  #promptInput: GwInput | undefined;

  /** What to do with the text the prompt asked for, once saved. */
  #onSave: ((text: string) => void) | undefined;

  /** Ask for a line of text beside the control clicked, such as a name. */
  #ask(
    event: Event,
    heading: string,
    label: string,
    value: string,
    save: (text: string) => void,
  ) {
    if (this.#prompt === undefined || this.#promptInput === undefined) return;

    this.#prompt.heading = heading;
    this.#promptInput.label = label;
    this.#promptInput.value = value;
    this.#onSave = save;
    this.#prompt.show(
      event.currentTarget instanceof Element ? event.currentTarget : undefined,
    );
  }

  #asked() {
    const text = this.#promptInput?.value.trim() ?? "";

    if (
      this.#prompt?.returnValue === "save" &&
      (text !== "" || this.#optional)
    ) {
      this.#onSave?.(text);
    }

    this.#onSave = undefined;
    this.#optional = false;
  }

  /** Whether the prompt open now saves with nothing typed. */
  #optional = false;

  /** Whether Since you last looked shows its full list, kept in this browser. */
  #sinceOpen = getStorage().get(sinceKey) === true;

  /** Workers that can open an agent, and the one used last here. */
  readonly #agents = new AtomController(this, () => agents, always);

  /** The tracked repositories, offered as places to start an agent. */
  readonly #repos = new AtomController(this, () => repos);

  /**
   * The latest command runs, for how each agent start is going. They're
   * polled while one is on its way, and left alone otherwise.
   */
  readonly #commands = new AtomController(
    this,
    () => runs("command"),
    (result) =>
      this.#starting.size > 0 ||
      (AsyncResult.isSuccess(result) &&
        result.value.some(
          (each) =>
            each.command?.kind === "start-agent" &&
            (each.state === "queued" || each.state === "running"),
        )),
  );

  /**
   * Starts asked for here that the server hasn't answered yet, by what
   * they're on, with the latest run on it then and when, so the click shows
   * at once.
   */
  readonly #starting = new Map<
    string,
    { readonly before: string | null; readonly at: number }
  >();

  /** The agent starts on an item or a group, newest first. */
  #startsOn(about: About) {
    const result = this.#commands.value;

    if (!AsyncResult.isSuccess(result)) return [];

    return result.value.filter((each) => {
      const command = each.command;

      if (command?.kind !== "start-agent") return false;

      return "url" in about
        ? command.url === about.url && command.group === null
        : command.group === about.group;
    });
  }

  /**
   * Where an agent can start, for an item or a group: the repositories it's
   * on first, as suggested, then Upkeep, to move or sort issues from, then
   * every other tracked repository.
   */
  #places(about: About) {
    const page = this.#attention.value;
    const items = AsyncResult.isSuccess(page) ? page.value.items : [];

    const urls =
      "url" in about
        ? [about.url]
        : (this.#groups
            .find((group) => group.id === about.group)
            ?.items.flatMap((link) => (link.suggested ? [] : [link.url])) ??
          []);

    const suggested = [
      ...new Set(
        items.flatMap((item) => (urls.includes(item.url) ? [item.repo] : [])),
      ),
    ];

    const tracked = AsyncResult.isSuccess(this.#repos.value)
      ? this.#repos.value.value
      : [];

    const nameOf = (repo: string) => {
      const found = tracked.find(
        (each) => each.repo.toLowerCase() === repo.toLowerCase(),
      );

      return found?.name ?? found?.title ?? repo;
    };

    const taken = new Set(suggested.map((repo) => repo.toLowerCase()));

    const upkeep = taken.has(upkeepRepo.toLowerCase()) ? [] : [upkeepRepo];

    const others = tracked
      .map((each) => each.repo)
      .filter(
        (repo) =>
          !taken.has(repo.toLowerCase()) &&
          repo.toLowerCase() !== upkeepRepo.toLowerCase(),
      )
      .toSorted((a, b) => nameOf(a).localeCompare(nameOf(b)));

    const place = (repo: string, group: string, description?: string) => ({
      value: repo,
      label: nameOf(repo),
      description: description ?? (nameOf(repo) === repo ? undefined : repo),
      group,
    });

    return [
      ...suggested.map((repo) => place(repo, "Suggested")),
      ...upkeep.map((repo) =>
        place(repo, "Upkeep", "Move or sort the issues from here"),
      ),
      ...others.map((repo) => place(repo, "Tracked repositories")),
    ];
  }

  /**
   * Start an agent on an item or a group: a menu of where to start it, the
   * item's own repository suggested first, then a prompt for what to ask it,
   * which can be left empty for a look at where it stands. It starts on the
   * worker used last here, with the others offered under the places.
   */
  #startMenu(about: About) {
    const result = this.#agents.value;

    const workers = AsyncResult.isSuccess(result)
      ? result.value
          .filter((each) => each.launch)
          .map((each) => each.worker)
          .toSorted((a, b) => a.localeCompare(b))
      : [];

    const stored = localStorage.getItem(lastWorkerKey);
    const worker = workers.find((each) => each === stored) ?? workers[0];

    if (worker === undefined) return nothing;

    const [latest] = this.#startsOn(about);

    const busy =
      this.#starting.has(key(about)) ||
      latest?.state === "queued" ||
      latest?.state === "running";

    const start = (event: Event, repo: string, label: string) => {
      this.#ask(
        event,
        `Start an agent in ${label}`,
        "What to ask it, or leave empty for where it stands",
        "",
        (text) => {
          this.#starting.set(key(about), {
            before: latest?.id ?? null,
            at: Date.now(),
          });
          registry.set(startAgent, {
            worker,
            url: "url" in about ? about.url : null,
            group: "group" in about ? about.group : null,
            repo,
            prompt: text === "" ? null : text,
          });
          this.requestUpdate();
        },
      );
      this.#optional = true;
    };

    const places = this.#places(about);

    return html`<gw-menu-button
      size="xs"
      appearance="plain"
      icon=${phRocketLaunch}
      label="Start agent"
      heading=${workers.length > 1 ? `Start in, on ${worker}` : "Start in"}
      ?loading=${busy}
      .items=${places}
      .actions=${workers
        .filter((each) => each !== worker)
        .map((each) => ({
          value: `worker:${each}`,
          label: `Use ${each} instead`,
          icon: phArrowsLeftRight,
        }))}
      @select=${(event: Event) => {
        const value = chosen(event);

        if (value.startsWith("worker:")) {
          localStorage.setItem(lastWorkerKey, value.slice("worker:".length));
          this.requestUpdate();

          return;
        }

        const place = places.find((each) => each.value === value);

        if (place !== undefined) start(event, place.value, place.label);
      }}
    ></gw-menu-button>`;
  }

  /**
   * How the latest agent start on an item or a group is going: on its way
   * to a worker, waiting for one, starting, started or failed, with its run.
   * A finished one shows for a few minutes.
   */
  #startStatus(about: About) {
    const [latest] = this.#startsOn(about);
    const pending = this.#starting.get(key(about));

    // The server has answered once a newer run than the one before shows; a
    // request that never got there stops waiting after a while
    if (
      pending !== undefined &&
      ((latest !== undefined && latest.id !== pending.before) ||
        Date.now() - pending.at > pendingFor)
    ) {
      this.#starting.delete(key(about));
    }

    if (this.#starting.has(key(about))) {
      return html`<p class="context">
        <gw-spinner size="small" label="Starting"></gw-spinner>
        <span>Asking for an agent…</span>
      </p>`;
    }

    if (latest === undefined) return nothing;

    const command = latest.command;

    const where =
      command?.kind === "start-agent" && command.repo !== undefined
        ? ` in ${command.repo}`
        : "";

    const on =
      latest.worker ?? (command?.kind === "start-agent" ? command.worker : "");

    const link = html`<a href=${runHref(latest.id)}>Run</a>`;

    if (latest.state === "queued") {
      return html`<p class="context">
        <gw-spinner size="small" label="Waiting"></gw-spinner>
        <span>Waiting for ${on} to pick up the agent${where}. ${link}</span>
      </p>`;
    }

    if (latest.state === "running") {
      return html`<p class="context">
        <gw-spinner size="small" label="Starting"></gw-spinner>
        <span
          >${on} is gathering the brief and opening the agent${where}.
          ${link}</span
        >
      </p>`;
    }

    if (
      latest.finishedAt === null ||
      Date.now() - latest.finishedAt > startShownFor
    ) {
      return nothing;
    }

    return latest.state === "succeeded"
      ? html`<p class="context">
          ${icon(phCheckCircle)}
          <span
            >Agent started${where} on ${on} ${time(latest.finishedAt)}.
            ${link}</span
          >
        </p>`
      : html`<p class="context failed">
          ${icon(phWarningCircle)}
          <span
            >Couldn't start the agent${where}: ${latest.error ?? latest.state}.
            ${link}</span
          >
        </p>`;
  }

  /** The popover the prompts share, kept outside the page header. */
  #promptPopover() {
    return html`<gw-popover
      ${ref((element) => {
        this.#prompt = element instanceof GwPopover ? element : undefined;
      })}
      @close=${() => this.#asked()}
    >
      <gw-input
        ${ref((element) => {
          this.#promptInput = element instanceof GwInput ? element : undefined;
        })}
      ></gw-input>
      <gw-button slot="actions" size="small" value="save">Save</gw-button>
    </gw-popover>`;
  }

  /** An item's Group menu: move it into a group, a new one, or out. */
  #groupMenu(item: Domain.AttentionItem) {
    const current = this.#groups.find((group) =>
      group.items.some((link) => link.url === item.url && !link.suggested),
    );

    const byYou = current?.items.some(
      (link) => link.url === item.url && link.source !== "github",
    );

    return html`<gw-menu-button
      size="xs"
      appearance="plain"
      icon=${phFolder}
      label="Group"
      heading=${current === undefined ? "Group" : `In ${current.name}`}
      empty="No groups yet"
      .items=${this.#groups
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((group) => ({
          value: group.id,
          label: group.name,
          checked: group.id === current?.id,
        }))}
      .actions=${[
        { value: "new", label: "New group", icon: phFolderPlus },
        ...(byYou === true
          ? [
              {
                value: "none",
                label: "Out of this group",
                icon: phFolderMinus,
              },
            ]
          : []),
      ]}
      @select=${(event: Event) => {
        const value = chosen(event);

        if (value === "new") {
          this.#ask(event, "New group", "Name", item.title, (name) =>
            registry.set(createGroup, { name, items: [item.url] }),
          );
        } else if (value === "none") {
          registry.set(linkAttention, { url: item.url, group: null });
        } else if (value !== "" && value !== current?.id) {
          registry.set(linkAttention, { url: item.url, group: value });
        }
      }}
    ></gw-menu-button>`;
  }

  /**
   * A group as a panel that folds like the sections around it: its items,
   * what it waits on, and its controls beside the heading.
   */
  #block(block: Block, since: number | null) {
    const { group } = block;

    const focus =
      focuses.find((each) => each.value === group.focus) ?? focuses[1];

    return html`<gw-expansion
      heading=${group.name}
      description=${`${group.source === "github" ? "Linked on GitHub" : "Grouped by you"}, ${plural(block.items.length, "item")}`}
      open
      storage-key=${groupKey(group.id)}
      .draw=${drawn(() => this.#blockBody(block, since))}
    >
      <span slot="actions">${this.#startMenu({ group: group.id })}</span>
      <gw-menu-button
        slot="actions"
        size="xs"
        appearance="plain"
        heading="Focus"
        label=${focus?.label ?? ""}
        .items=${focuses.map((each) => ({
          value: each.value,
          label: each.label,
          description: each.description,
          checked: each.value === group.focus,
        }))}
        @select=${(event: Event) => {
          const value = chosen(event);

          if (isFocus(value)) {
            registry.set(updateGroup, { id: group.id, focus: value });
          }
        }}
      ></gw-menu-button>
      <gw-menu-button
        slot="actions"
        size="xs"
        appearance="plain"
        labels="hide"
        icon=${phDotsThreeVertical}
        label="More"
        .items=${[
          {
            value: "wait",
            label: "Add an outside wait",
            icon: phClock,
          },
          {
            value: "comment",
            label: "Tell the agent",
            icon: phChatCircle,
          },
          { value: "rename", label: "Rename", icon: phPencilSimple },
          ...(group.source === "github"
            ? []
            : [
                {
                  value: "remove",
                  label: "Remove group",
                  icon: phTrash,
                },
              ]),
        ]}
        @select=${(event: Event) => {
          const value = chosen(event);

          if (value === "wait") {
            this.#ask(event, "Waiting on", "What, and when", "", (text) =>
              registry.set(addWait, { group: group.id, text }),
            );
          } else if (value === "comment") {
            this.#ask(
              event,
              "Tell the agent",
              "Such as: close the tracking issue once these land",
              "",
              (text) =>
                registry.set(commentAttention, { group: group.id, text }),
            );
          } else if (value === "rename") {
            this.#ask(event, "Rename group", "Name", group.name, (name) =>
              registry.set(updateGroup, { id: group.id, name }),
            );
          } else if (value === "remove") {
            registry.set(deleteGroup, group.id);
          }
        }}
      ></gw-menu-button>
    </gw-expansion>`;
  }

  /** What a group shows open: follow-up, comments, waits and items. */
  #blockBody(block: Block, since: number | null) {
    const { group } = block;

    return html`<gw-stack gap="s">
      ${this.#startStatus({ group: group.id })}
      ${
        group.followUp === null
          ? nothing
          : html`<p class="context">
              ${icon(phRobot)}
              <span>${group.followUp.text}</span>
            </p>`
      }
      ${this.#commentLines((comment) => comment.group === group.id)}
      ${
        group.waits.length === 0
          ? nothing
          : html`<ul class="waits">
              ${group.waits.map(
                (wait) =>
                  html`<li>
                    ${icon(phClock)}
                    <span
                      >Waiting on
                      ${wait.url === null ? wait.text : externalLink(wait.url, wait.text)}</span
                    >
                    <gw-button
                      size="xs"
                      appearance="plain"
                      variant="neutral"
                      labels="hide"
                      icon=${phX}
                      label="Remove"
                      @click=${() => registry.set(removeWait, wait.id)}
                    ></gw-button>
                  </li>`,
              )}
            </ul>`
      }
      <ul class="items">
        ${block.items.map((item) => this.#item(item, since))}
      </ul>
    </gw-stack>`;
  }

  override connectedCallback() {
    super.connectedCallback();
    migrateCollapsed();
    registry.set(openAttention, undefined);
  }

  /** Whether the attention job is queued or running now. */
  #collecting() {
    const result = this.#jobs.value;

    if (!AsyncResult.isSuccess(result)) return false;

    const state = result.value.find((job) => job.id === "attention")?.lastRun
      ?.state;

    return state === "queued" || state === "running";
  }

  /** Your comments on an item or a group, and what the agent did about each. */
  #commentLines(about: (comment: Domain.AttentionComment) => boolean) {
    return this.#comments.filter(about).map(
      (comment) =>
        html`<p class="context">
          ${icon(phChatCircle)}
          <span
            >You said: ${comment.text}.
            ${
              comment.outcome === null
                ? html`<span class="pending">Waiting for the agent.</span>`
                : html`Agent: ${comment.outcome}`
            }</span
          >
        </p>`,
    );
  }

  /**
   * What the context agent says about an item: its note, a group it suggests,
   * and your comments with what it did about them.
   */
  #context(item: Domain.AttentionItem) {
    const { note } = item;

    const suggested = this.#groups.find((group) =>
      group.items.some((link) => link.url === item.url && link.suggested),
    );

    return html`
      ${
        note === null
          ? nothing
          : html`<p class="context">
              ${icon(phRobot)}
              <span
                >${note.text}${
                  note.recheckAt === null
                    ? nothing
                    : html` <span class="pending"
                        >Recheck
                        ${new Date(note.recheckAt).toLocaleDateString()}</span
                      >`
                }${
                  note.fingerprint === item.fingerprint
                    ? nothing
                    : html` <span class="pending"
                        >(before its last change)</span
                      >`
                }</span
              >
            </p>`
      }
      ${
        suggested === undefined
          ? nothing
          : html`<p class="context">
              ${icon(phFolder)}
              <span>The agent suggests ${suggested.name}</span>
              <gw-button
                size="xs"
                appearance="plain"
                icon=${phCheck}
                @click=${() =>
                  registry.set(linkAttention, {
                    url: item.url,
                    group: suggested.id,
                  })}
                >Accept</gw-button
              >
              <gw-button
                size="xs"
                appearance="plain"
                variant="neutral"
                icon=${phX}
                @click=${() =>
                  registry.set(linkAttention, { url: item.url, group: null })}
                >Dismiss</gw-button
              >
            </p>`
      }
      ${this.#commentLines((comment) => comment.url === item.url)}
    `;
  }

  /** A button asking for a comment for the agent, about an item or a group. */
  #commentButton(about: About) {
    return html`<gw-button
      size="xs"
      appearance="plain"
      variant="neutral"
      icon=${phChatCircle}
      @click=${(event: Event) =>
        this.#ask(
          event,
          "Tell the agent",
          "Such as: waiting on the December release",
          "",
          (text) => registry.set(commentAttention, { ...about, text }),
        )}
      >Comment</gw-button
    >`;
  }

  /** Standing instructions the agent follows, yours or from your comments. */
  #rules(page: Domain.Attention) {
    return html`<gw-expansion
      heading=${`Agent rules (${page.rules.length})`}
      description="Standing instructions the context agent follows on every run"
      storage-key=${sectionKey("rules")}
      .draw=${drawn(() => this.#rulesBody(page))}
    ></gw-expansion>`;
  }

  #rulesBody(page: Domain.Attention) {
    return html`<gw-stack gap="s">
      ${
        page.rules.length === 0
          ? html`<p class="description">
              None yet. A comment that's a standing instruction becomes one.
            </p>`
          : html`<ul class="waits">
              ${page.rules.map(
                (rule) =>
                  html`<li>
                    ${icon(phRobot)}
                    <span>${rule.text}</span>
                    <gw-button
                      size="xs"
                      appearance="plain"
                      variant="neutral"
                      labels="hide"
                      icon=${phX}
                      label="Remove"
                      @click=${() => registry.set(removeRule, rule.id)}
                    ></gw-button>
                  </li>`,
              )}
            </ul>`
      }
      <div class="actions">
        <gw-button
          size="xs"
          appearance="outlined"
          variant="neutral"
          icon=${phPlus}
          @click=${(event: Event) =>
            this.#ask(
              event,
              "New rule",
              "Such as: skip threads I'm only subscribed to",
              "",
              (text) => registry.set(addRule, text),
            )}
          >Add a rule</gw-button
        >
      </div>
    </gw-stack>`;
  }

  /** Its status and type labels, then what GitHub says about it. */
  #signals(item: Domain.AttentionItem) {
    const status = Domain.statusOf(item.labels);

    const labels = item.labels.filter((label) => {
      const name = label.toLowerCase();

      return name === status || typeLabels.has(name);
    });

    return [
      ...labels.map((label) => {
        const name = label.toLowerCase();

        return html`<gw-chip
          size="xs"
          tone=${name === status && status !== null ? statusTones[status] : "neutral"}
          >${label}</gw-chip
        >`;
      }),
      ...item.signals.map(
        (signal) =>
          html`<gw-chip size="xs" tone=${tones[signal.kind]}
            >${Domain.signalLabel(signal.kind)}${
              signal.detail === null ? nothing : html` (${signal.detail})`
            }</gw-chip
          >`,
      ),
    ];
  }

  #item(item: Domain.AttentionItem, since: number | null) {
    const moved = since !== null && item.changedAt > since;

    return html`<li class=${moved ? "moved" : ""}>
      ${icon(kindIcons[item.kind])}
      <div class="body">
        <span class="title">${externalLink(item.url, item.title)}</span>
        <div class="meta">
          <span
            >${item.repo}${item.number === null ? "" : `#${item.number}`}</span
          >
          ${
            item.yours || item.author === null
              ? nothing
              : html`<span>by ${item.author}</span>`
          }
          <span>active ${time(item.activityAt)}</span>
          ${moved ? html`<gw-chip size="xs" tone="accent">Moved</gw-chip>` : nothing}
          ${this.#signals(item)}
        </div>
        ${this.#context(item)} ${this.#startStatus({ url: item.url })}
        <div class="actions">
          ${
            item.notification?.unread === true
              ? html`<gw-button
                  size="xs"
                  appearance="plain"
                  variant="neutral"
                  icon=${phEnvelopeOpen}
                  @click=${() => {
                    if (item.notification !== null) {
                      registry.set(markNotificationRead, item.notification.id);
                    }
                  }}
                  >Mark read</gw-button
                >`
              : nothing
          }
          <gw-button
            size="xs"
            appearance="plain"
            variant="neutral"
            icon=${item.hidden ? phEye : phEyeSlash}
            @click=${() =>
              registry.set(hideAttention, {
                url: item.url,
                hidden: !item.hidden,
              })}
            >${item.hidden ? "Show" : "Hide"}</gw-button
          >
          ${this.#groupMenu(item)} ${this.#commentButton({ url: item.url })}
          ${this.#startMenu({ url: item.url })}
        </div>
      </div>
    </li>`;
  }

  /** The latest release of each repository with something in scope. */
  #releases(
    page: Domain.Attention,
    shown: ReadonlyArray<Domain.AttentionItem>,
  ) {
    const repos = new Set(shown.map((item) => item.repo.toLowerCase()));

    const releases = page.releases.filter((release) =>
      repos.has(release.repo.toLowerCase()),
    );

    return releases.length === 0
      ? nothing
      : html`<gw-expansion
          heading=${`Latest releases (${releases.length})`}
          description="Of the repositories above, newest first"
          storage-key=${sectionKey("releases")}
          .draw=${drawn(() => this.#releaseTable(page, releases))}
        ></gw-expansion>`;
  }

  #releaseTable(
    page: Domain.Attention,
    releases: Domain.Attention["releases"],
  ) {
    const draw = drawFrom(
      new Map(releases.map((release, index) => [String(index), release])),
    );

    const columns: TableColumn[] = [
      {
        id: "repo",
        header: "Repository",
        wide: true,
        cell: draw((release) => release.repo, "fill"),
      },
      {
        id: "tag",
        header: "Release",
        cell: draw((release) => externalLink(release.url, release.tag), {
          width: "9rem",
        }),
      },
      {
        id: "seen",
        header: "Seen",
        searchable: false,
        cell: draw(
          (release) =>
            html`${time(release.seenAt)}${
              page.since !== null && release.seenAt > page.since
                ? html` <gw-chip size="xs" tone="accent">New</gw-chip>`
                : nothing
            }`,
          { width: "10rem" },
        ),
      },
    ];

    return html`<gw-table
      label="Latest releases"
      contained
      row-key="id"
      sort="seen"
      descending
      search-label="Search releases"
      .columns=${columns}
      .rows=${releases.map((release, index) => ({
        id: String(index),
        repo: release.repo,
        tag: release.tag,
        seen: release.seenAt,
      }))}
    ></gw-table>`;
  }

  /** What went over the last week, whatever the scope, as a history. */
  #gone(page: Domain.Attention) {
    const gone = page.changes.filter((change) => change.gone);

    return gone.length === 0
      ? nothing
      : html`<gw-expansion
          heading=${`Gone (${gone.length})`}
          description="Closed, or no longer involving you, over the last week"
          storage-key=${sectionKey("gone")}
          .draw=${drawn(() => changeTable(gone, "Gone"))}
        ></gw-expansion>`;
  }

  #changes(page: Domain.Attention, scope: Scope) {
    const work = new Map(page.items.map((item) => [item.url, item.work]));

    // What went is kept apart, under Gone
    const changes = page.changes.filter((change) => {
      const isWork = work.get(change.url);

      return !change.gone && (isWork === undefined || inScope(isWork, scope));
    });

    const open = this.#sinceOpen && changes.length > 0;
    const more = changes.length - maxSummaryLinks;

    // One line of links to what moved, with the full list folded away
    return html`<gw-card>
      <div class="since">
        <span class="title">Since you last looked</span>
        <span class="meta"
          >${
            changes.length === 0
              ? "Nothing moved"
              : plural(changes.length, "change")
          }${
            page.since === null
              ? nothing
              : html`, since ${new Date(page.since).toLocaleString()}`
          }</span
        >
        <span class="since-links">
          ${changes
            .slice(0, maxSummaryLinks)
            .map((change) => externalLink(change.url, change.title))}
        </span>
        ${more > 0 ? html`<span class="meta">+${more}</span>` : nothing}
        ${
          changes.length === 0
            ? nothing
            : html`<gw-button
                size="xs"
                appearance="plain"
                variant="neutral"
                aria-expanded=${open ? "true" : "false"}
                @click=${() => {
                  this.#sinceOpen = !this.#sinceOpen;
                  getStorage().set(sinceKey, this.#sinceOpen);
                  this.requestUpdate();
                }}
                >${open ? "Hide" : "Details"}</gw-button
              >`
        }
      </div>
      ${open ? changeTable(changes, "What moved") : nothing}
    </gw-card>`;
  }

  #render(page: Domain.Attention) {
    const scope =
      this.#scope ??
      (page.workTime === null ? "all" : page.workTime ? "work" : "personal");

    const visible = page.items.filter((item) => !item.hidden);
    const shown = visible.filter((item) => inScope(item.work, scope));

    const hidden = page.items
      .filter((item) => item.hidden && inScope(item.work, scope))
      .toSorted((a, b) => b.activityAt - a.activityAt);

    this.#groups = page.groups;
    this.#comments = page.comments;

    const groupOf = new Map(
      page.groups.flatMap((group) =>
        group.items.flatMap((link) =>
          link.suggested ? [] : [[link.url, group.id] as const],
        ),
      ),
    );

    const rank = (section: Domain.AttentionSection) => urgency.indexOf(section);

    // Each group with what it shows now; one with nothing in scope stays out,
    // unless it's new and empty, waiting for its first item
    const blocks = page.groups.flatMap((group): Array<Block> => {
      const items = shown
        .filter((item) => groupOf.get(item.url) === group.id)
        .toSorted(
          (a, b) =>
            rank(a.section) - rank(b.section) || b.activityAt - a.activityAt,
        );

      if (items.length === 0 && group.items.length > 0) return [];

      return [{ group, items, section: items[0]?.section ?? "waiting" }];
    });

    const placed = (section: Domain.AttentionSection) =>
      blocks.filter(
        (block) =>
          block.group.focus === "watching" && block.section === section,
      );

    const pinned = blocks.filter((block) => block.group.focus === "today");
    const parked = blocks.filter((block) => block.group.focus === "parked");

    const of = (section: Domain.AttentionSection) =>
      shown
        .filter((item) => item.section === section && !groupOf.has(item.url))
        .toSorted(order(section));

    const count = (section: Domain.AttentionSection) =>
      of(section).length +
      placed(section).reduce((total, block) => total + block.items.length, 0);

    const needs = shown.filter((item) => item.section === "needs-you").length;
    const collecting = this.#collecting();

    // A refresh this soon after the last collection would queue nothing
    const minutesLeft =
      page.refreshAt === null
        ? 0
        : Math.ceil((page.refreshAt - Date.now()) / 60_000);

    return html`
      <gw-stack gap="l">
        <gw-page-header
          heading="Attention"
          description=${
            page.collectedAt === null
              ? "Nothing collected yet"
              : `${needs === 0 ? "Nothing needs you" : `${plural(needs, "item")} need you`}. Collected ${new Date(page.collectedAt).toLocaleString()}`
          }
        >
          <gw-segmented
            slot="actions"
            size="small"
            label="Scope"
            value=${scope}
            .options=${scopes.map((option) => ({
              value: option.value,
              label: `${option.label} ${
                visible.filter((item) => inScope(item.work, option.value))
                  .length
              }`,
            }))}
            @change=${(event: Event) => {
              const value =
                event.currentTarget instanceof GwSegmented
                  ? event.currentTarget.value
                  : "";

              if (isScope(value)) {
                this.#scope = value;
                this.requestUpdate();
              }
            }}
          ></gw-segmented>
          <gw-button
            slot="actions"
            appearance="outlined"
            variant="neutral"
            icon=${phArrowClockwise}
            ?loading=${collecting}
            ?disabled=${collecting || minutesLeft > 0}
            @click=${() => registry.set(openAttention, undefined)}
            >${
              collecting
                ? "Collecting"
                : minutesLeft > 0
                  ? `Refresh in ${minutesLeft} min`
                  : "Refresh"
            }</gw-button
          >
        </gw-page-header>

        ${
          page.collectedAt === null
            ? empty(
                phArrowClockwise,
                "The first collection is queued. Items show here once a worker sends them.",
              )
            : html`
                ${this.#changes(page, scope)}
                ${
                  pinned.length === 0
                    ? nothing
                    : html`<gw-stack gap="s">
                        <gw-section-title
                          >Today (${pinned.length})</gw-section-title
                        >
                        <p class="description">Groups you set to today</p>
                        ${pinned.map((block) => this.#block(block, page.since))}
                      </gw-stack>`
                }
                ${sections.map((section) => {
                  const items = of(section.id);

                  return html`<gw-stack gap="s">
                    <gw-section-title
                      >${section.heading}
                      (${count(section.id)})</gw-section-title
                    >
                    <p class="description">${section.description}</p>
                    ${placed(section.id).map((block) =>
                      this.#block(block, page.since),
                    )}
                    ${
                      items.length === 0
                        ? nothing
                        : html`<gw-card
                            ><ul class="items">
                              ${items.map((item) => this.#item(item, page.since))}
                            </ul></gw-card
                          >`
                    }
                  </gw-stack>`;
                })}
                ${folded.map((section) => {
                  const items = of(section.id);

                  return html`<gw-expansion
                    heading=${`${section.heading} (${count(section.id)})`}
                    description=${section.description}
                    storage-key=${sectionKey(section.id)}
                    .draw=${drawn(
                      () =>
                        html`<gw-stack gap="s">
                          ${placed(section.id).map((block) =>
                            this.#block(block, page.since),
                          )}
                          <ul class="items">
                            ${items.map((item) => this.#item(item, page.since))}
                          </ul>
                        </gw-stack>`,
                    )}
                  ></gw-expansion>`;
                })}
                ${
                  parked.length === 0
                    ? nothing
                    : html`<gw-expansion
                        heading=${`Parked (${parked.length})`}
                        description="Groups put away for now"
                        storage-key=${sectionKey("parked")}
                        .draw=${drawn(
                          () =>
                            html`<gw-stack gap="s">
                              ${parked.map((block) => this.#block(block, page.since))}
                            </gw-stack>`,
                        )}
                      ></gw-expansion>`
                }
                ${
                  hidden.length === 0
                    ? nothing
                    : html`<gw-expansion
                        heading=${`Hidden (${hidden.length})`}
                        description="Each comes back once anything about it changes"
                        storage-key=${sectionKey("hidden")}
                        .draw=${drawn(
                          () =>
                            html`<ul class="items">
                              ${hidden.map((item) => this.#item(item, page.since))}
                            </ul>`,
                        )}
                      ></gw-expansion>`
                }
                ${this.#releases(page, shown)} ${this.#gone(page)}
                ${this.#rules(page)}
              `
        }
      </gw-stack>
      ${this.#promptPopover()}
    `;
  }

  override render() {
    return view(
      this.#attention.value,
      (page) => this.#render(page),
      html`<gw-stack gap="l" aria-busy="true">
        <gw-page-header heading="Attention"></gw-page-header>
        <gw-card loading lines="2"></gw-card>
        ${sections.map(
          (section) =>
            html`<gw-stack gap="s">
              <gw-section-title>${section.heading}</gw-section-title>
              <gw-card loading lines="3"></gw-card>
            </gw-stack>`,
        )}
      </gw-stack>`,
    );
  }
}

customElements.define("upkeep-attention", UpkeepAttention);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-attention": UpkeepAttention;
  }
}
