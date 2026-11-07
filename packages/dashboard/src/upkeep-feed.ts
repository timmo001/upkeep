/**
 * `upkeep-feed`: inbox entries under days that fold, as a groundwork
 * `gw-list`, so only the entries on screen are drawn however long it gets.
 * Each entry is an expansion panel saying what it did; its changes, as a
 * table, links to the job and run behind it, and its Move menu are only
 * drawn once it's opened, which also marks it read.
 */
import { Catalogue, type Domain } from "@upkeep/api";
import "@timmo001/groundwork-ui/define/gw-expansion.ts";
import { GwExpansion } from "@timmo001/groundwork-ui/gw-expansion.ts";
import type {
  TableColumn,
  TableRow,
} from "@timmo001/groundwork-ui/gw-table.ts";
import { css, html, LitElement, nothing, render } from "lit";
import { registry } from "./AtomController.ts";
import {
  dayOf,
  describe,
  fixesOf,
  jobOf,
  kinds,
  plural,
  titleOf,
  type Titles,
} from "./entries.ts";
import {
  phArrowCircleUp,
  phArrowCounterClockwise,
  phArrowsLeftRight,
  phStar,
} from "./icons.ts";
import { chosen, externalLink, shared, time } from "./ui.ts";
import { type CellContent, type CellSize, cell } from "./upkeep-cell.ts";
import {
  jobHref,
  markRead,
  placeEntry,
  runHref,
  setInboxRules,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-chip.ts";
import "@timmo001/groundwork-ui/define/gw-dot.ts";
import "@timmo001/groundwork-ui/define/gw-list.ts";
import "@timmo001/groundwork-ui/define/gw-menu-button.ts";
import "@timmo001/groundwork-ui/define/gw-table.ts";
import "@timmo001/groundwork-ui/define/layout.ts";

const keyOf = (entry: Domain.Entry) => entry.id;

/** The heading of an entry's Move menu, saying who put it where it is. */
const placedHeadings: Record<Domain.EntryPlacer, string> = {
  upkeep: "Show in, by Upkeep's call",
  repository: "Show in, by its repository's rule",
  you: "Show in, where you moved it",
};

/** The day an entry belongs to, as the start of that day, so it sorts and keeps. */
const dayKey = (entry: Domain.Entry) =>
  String(new Date(entry.lastAt).setHours(0, 0, 0, 0));

const dayLabel = (value: string) => dayOf(Number(value));

export class UpkeepFeed extends LitElement {
  static override properties = {
    entries: { attribute: false },
    titles: { attribute: false },
    storageKey: { attribute: "storage-key" },
  };

  static override styles = [
    shared,
    css`
      .read::part(heading) {
        font-weight: normal;
        color: var(--gw-color-text-secondary);
      }

      .when {
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }

      gw-table {
        --gw-table-max-height: 24rem;
      }
    `,
  ];

  declare entries: ReadonlyArray<Domain.Entry>;

  declare titles: Titles;

  /** Where the days folded away are kept, so each page keeps its own. */
  declare storageKey: string;

  /** Draws an entry into the list, made again when the titles change. */
  #draw = (entry: Domain.Entry, target: HTMLElement) => {
    render(this.#entry(entry), target);
  };

  constructor() {
    super();
    this.entries = [];
    this.titles = new Map();
    this.storageKey = "";
  }

  override willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has("titles")) {
      this.#draw = (entry, target) => {
        render(this.#entry(entry), target);
      };
    }
  }

  /** Marks an entry read once it's opened, after the frame that opens it. */
  #toggled(entry: Domain.Entry, event: Event) {
    if (
      event.target !== event.currentTarget ||
      !(event.currentTarget instanceof GwExpansion) ||
      !event.currentTarget.open ||
      entry.readAt !== null
    ) {
      return;
    }

    requestAnimationFrame(() => {
      setTimeout(() => registry.set(markRead, [entry.id]));
    });
  }

  /** Links to the job behind an entry and, while it's kept, its run. */
  #source(entry: Domain.Entry) {
    const job = jobOf(entry);
    const name = Catalogue.jobs.find((known) => known.id === job)?.name;

    return html`${
      job === null || name === undefined
        ? nothing
        : html`<span class="when"
            >From <a href=${jobHref(job)}>${name}</a></span
          >`
    }
    ${
      entry.run === null
        ? nothing
        : html`<a href=${runHref(entry.run)}>The run</a>`
    }`;
  }

  /** What an entry changed, newest first, as a table of its own. */
  #changes(entry: Domain.Entry) {
    const byId = new Map(
      entry.items.map((item, index) => [String(index), item]),
    );

    const draw =
      (
        content: (item: Domain.Entry["items"][number]) => CellContent,
        size: CellSize,
      ) =>
      (row: TableRow) => {
        const item = byId.get(String(row.id));

        return cell(item === undefined ? "" : content(item), size);
      };

    const columns: TableColumn[] = [
      {
        id: "repo",
        header: "Repository",
        cell: draw((item) => titleOf(item.repo, this.titles), {
          width: "9rem",
        }),
      },
      {
        id: "text",
        header: "Change",
        wide: true,
        cell: draw(
          (item) =>
            item.url === null ? item.text : externalLink(item.url, item.text),
          "fill",
        ),
      },
      {
        id: "at",
        header: "When",
        searchable: false,
        cell: draw((item) => time(item.at), { width: "7rem" }),
      },
    ];

    return html`<gw-table
      label="Changes"
      contained
      row-key="id"
      sort="at"
      descending
      search-label="Search changes"
      .columns=${columns}
      .rows=${entry.items.map((item, index) => ({
        id: String(index),
        repo: titleOf(item.repo, this.titles),
        text: item.text,
        at: item.at,
      }))}
    ></gw-table>`;
  }

  /**
   * Where an entry shows, and the choices to move it: to the version bumps
   * or what's worth reading, back to Upkeep's call, or a rule for its one
   * repository. An entry placed by rules can drop them here too.
   */
  #placing(entry: Domain.Entry) {
    const repos = [
      ...new Set(entry.items.map((item) => item.repo.toLowerCase())),
    ];

    const [first] = entry.items;
    const name = first === undefined ? "" : titleOf(first.repo, this.titles);

    const ruleActions =
      entry.placedBy === "repository"
        ? [
            {
              value: "rule:none",
              label:
                repos.length === 1
                  ? `Drop the rule for ${name}`
                  : "Drop the rules for these repositories",
              icon: phArrowCounterClockwise,
            },
          ]
        : repos.length === 1
          ? [
              {
                value: "rule:bumps",
                label: `Always fold ${name} into version bumps`,
                icon: phArrowCircleUp,
              },
              {
                value: "rule:worth",
                label: `Always show ${name} as worth reading`,
                icon: phStar,
              },
            ]
          : [];

    return html`<gw-menu-button
      size="xs"
      appearance="plain"
      icon=${phArrowsLeftRight}
      label="Move"
      heading=${placedHeadings[entry.placedBy]}
      .items=${[
        {
          value: "worth",
          label: "Worth reading",
          icon: phStar,
          checked: !entry.routine,
        },
        {
          value: "bumps",
          label: "Version bumps",
          icon: phArrowCircleUp,
          checked: entry.routine,
        },
      ]}
      .actions=${[
        ...(entry.placedBy === "you"
          ? [
              {
                value: "upkeep",
                label: "Back to Upkeep's call",
                icon: phArrowCounterClockwise,
              },
            ]
          : []),
        ...ruleActions,
      ]}
      @select=${(event: Event) => {
        const value = chosen(event);

        if (value === "worth" || value === "bumps" || value === "upkeep") {
          registry.set(placeEntry, {
            id: entry.id,
            routine: value === "upkeep" ? null : value === "bumps",
          });
        } else if (value.startsWith("rule:")) {
          registry.set(setInboxRules, {
            repos,
            routine: value === "rule:none" ? null : value === "rule:bumps",
          });
        }
      }}
    ></gw-menu-button>`;
  }

  /** What an entry shows open: what it was, when, where from, and its changes. */
  #body(entry: Domain.Entry) {
    const kind = kinds[entry.kind];
    const fixes = fixesOf(entry);

    return html`<gw-stack gap="s">
      <gw-row gap="s">
        <gw-chip size="xs" tone=${entry.you ? "accent" : kind.tone}
          >${entry.you ? "You" : kind.label}</gw-chip
        >
        ${
          fixes.length > 0
            ? html`<gw-chip size="xs" tone="success"
                >${plural(fixes.length, "fix", "fixes")} by Upkeep</gw-chip
              >`
            : nothing
        }
        ${
          entry.routine
            ? html`<gw-chip size="xs">Version bump</gw-chip>`
            : nothing
        }
        <span class="when">${time(entry.lastAt)}</span>
        ${entry.url === null ? nothing : externalLink(entry.url, "The release")}
        ${this.#source(entry)} ${this.#placing(entry)}
      </gw-row>
      ${this.#changes(entry)}
    </gw-stack>`;
  }

  #entry(entry: Domain.Entry) {
    const { heading, description } = describe(entry, this.titles);
    const unread = entry.readAt === null;

    return html`<gw-expansion
      class=${unread ? "" : "read"}
      heading=${heading}
      description=${description}
      .draw=${(target: HTMLElement) => {
        render(this.#body(entry), target);
      }}
      @toggle=${(event: Event) => this.#toggled(entry, event)}
    >
      <gw-dot
        slot="icon"
        tone=${unread ? "accent" : "neutral"}
        label=${unread ? "Unread" : "Read"}
      ></gw-dot>
    </gw-expansion>`;
  }

  override render() {
    return html`<gw-list
      label="What changed"
      storage-key=${this.storageKey}
      estimate="64"
      .items=${this.entries}
      .keyOf=${keyOf}
      .groupOf=${dayKey}
      .groupLabel=${dayLabel}
      .draw=${this.#draw}
    ></gw-list>`;
  }
}

customElements.define("upkeep-feed", UpkeepFeed);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-feed": UpkeepFeed;
  }
}
