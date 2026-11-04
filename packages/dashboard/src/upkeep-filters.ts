/**
 * `upkeep-filters`: how the inbox's feed is narrowed, as triage's issue list
 * does it. Kinds are tabs over the feed, each with its count and explained
 * under them; the rest are groundwork filters in a sheet opened from the
 * Filters button, which counts the filters that are on: read or unread, and
 * which repositories. Each filter that's on shows as a chip that takes it
 * off. Fires `filters-change` with the new filters.
 */
import { mdiClose, mdiFilterVariant, mdiSourceRepository } from "@mdi/js";
import { GwFilter } from "@timmo001/groundwork-ui/gw-filter.ts";
import { GwSegmented } from "@timmo001/groundwork-ui/gw-segmented.ts";
import { GwSheet } from "@timmo001/groundwork-ui/gw-sheet.ts";
import type { Domain } from "@upkeep/api";
import { css, html, LitElement, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { plural, titleOf, type Titles } from "./entries.ts";
import { shared } from "./ui.ts";
import "@timmo001/groundwork-ui/gw-button.ts";
import "@timmo001/groundwork-ui/layout.ts";

/** What the feed shows by kind: everything worth reading, one kind, or the routine updates. */
export type KindFilter = "worth" | Domain.EntryKind | "routine";

/** Whether an entry has been read, as the read filter names it. */
type ReadState = "unread" | "read";

export interface Filters {
  readonly kind: KindFilter;
  /** The read states to show; empty for both. */
  readonly read: ReadonlyArray<string>;
  /** The repositories to show, by lower-cased `owner/name`; empty for all. */
  readonly repos: ReadonlyArray<string>;
}

export const noFilters: Filters = {
  kind: "worth",
  read: [],
  repos: [],
};

/** Each kind of entry, and what it means, shown under the tabs. */
export const kindTabs: ReadonlyArray<{
  readonly value: KindFilter;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "worth",
    label: "Worth reading",
    description:
      "Everything that changed something real: releases, commits, updates and drift moves that needed a code or config change, and Upkeep's fixes. Version bumps are left out.",
  },
  {
    value: "release",
    label: "Releases",
    description:
      "A release of one of your repositories, with every repository Upkeep updated to it and any fix that needed.",
  },
  {
    value: "commit",
    label: "Commits",
    description:
      "Commits pushed to a repository by you or anyone else outside Upkeep, one entry per repository per day.",
  },
  {
    value: "update",
    label: "Updates",
    description:
      "Dependency updates from Renovate, Dependabot or Upkeep that needed a code or config change to land.",
  },
  {
    value: "drift",
    label: "Drift",
    description:
      "A tool pinned in a repository's tooling.yml that Upkeep moved to its latest release.",
  },
  {
    value: "fix",
    label: "Fixes",
    description:
      "A fix Upkeep's heal agent pushed to get a failing job or repository working again.",
  },
  {
    value: "routine",
    label: "Version bumps",
    description:
      "Updates that only moved version numbers, lockfiles, CI pins, submodules or tool versions, with no code changed. Kept out of the way, but here if you want them.",
  },
];

const isKindFilter = (value: string): value is KindFilter =>
  kindTabs.some((tab) => tab.value === value);

const readStateOf = (entry: Domain.Entry): ReadState =>
  entry.readAt === null ? "unread" : "read";

/** Whether an entry shows under a kind. */
export const matchesKind = (entry: Domain.Entry, kind: KindFilter) => {
  if (kind === "routine") return entry.routine;

  if (entry.routine) return false;

  return kind === "worth" || entry.kind === kind;
};

/** Whether an entry shows under every filter but the kind. */
const matchesRest = (entry: Domain.Entry, filters: Filters) =>
  (filters.read.length === 0 || filters.read.includes(readStateOf(entry))) &&
  (filters.repos.length === 0 ||
    entry.items.some((item) =>
      filters.repos.includes(item.repo.toLowerCase()),
    ));

/** Whether an entry shows under every filter. */
export const matches = (entry: Domain.Entry, filters: Filters) =>
  matchesKind(entry, filters.kind) && matchesRest(entry, filters);

/** The new value of the filter an event came from. */
const filterValue = (event: Event) =>
  event.currentTarget instanceof GwFilter ? event.currentTarget.value : [];

export class UpkeepFilters extends LitElement {
  static override properties = {
    entries: { attribute: false },
    titles: { attribute: false },
    filters: { attribute: false },
  };

  static override styles = [
    shared,
    css`
      .bar {
        display: flex;
        flex-wrap: wrap;
        gap: var(--gw-space-2);
        align-items: center;
      }

      /* On a narrow screen the tabs scroll sideways on one line */
      .tabs {
        flex: 1 1 auto;
        min-width: 0;
        overflow-x: auto;
        overflow-y: hidden;
        white-space: nowrap;
        scrollbar-width: none;
      }

      .tabs gw-segmented {
        width: max-content;
      }

      .on {
        margin-top: var(--gw-space-2);
      }

      .explain {
        margin: var(--gw-space-2) 0 0;
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }

      gw-sheet {
        --gw-filter-inset: var(--gw-space-4);
      }
    `,
  ];

  declare entries: ReadonlyArray<Domain.Entry>;

  declare titles: Titles;

  declare filters: Filters;

  #sheet: GwSheet | undefined;

  constructor() {
    super();
    this.entries = [];
    this.titles = new Map();
    this.filters = noFilters;
  }

  #change(next: Partial<Filters>) {
    this.dispatchEvent(
      new CustomEvent<Filters>("filters-change", {
        detail: { ...this.filters, ...next },
      }),
    );
  }

  /** Every repository the entries reached, with how many entries each, by title. */
  #repoOptions() {
    const counts = new Map<string, number>();

    for (const entry of this.entries) {
      for (const repo of new Set(
        entry.items.map((item) => item.repo.toLowerCase()),
      )) {
        counts.set(repo, (counts.get(repo) ?? 0) + 1);
      }
    }

    return [...counts]
      .map(([repo, count]) => ({
        value: repo,
        label: titleOf(repo, this.titles),
        description: repo,
        count,
      }))
      .toSorted((a, b) => a.label.localeCompare(b.label));
  }

  #readOptions() {
    const unread = this.entries.filter(
      (entry) => readStateOf(entry) === "unread",
    ).length;

    return [
      {
        value: "unread",
        label: "Unread",
        description: "Not read since it came in",
        count: unread,
      },
      {
        value: "read",
        label: "Read",
        description: "Already read, or marked read",
        count: this.entries.length - unread,
      },
    ];
  }

  /** The filters that are on, besides the kind, each as a chip that takes it off. */
  #onChips() {
    const chips = [
      ...(this.filters.read.length === 0
        ? []
        : [
            {
              label: this.filters.read.includes("unread")
                ? "Unread only"
                : "Read only",
              off: () => this.#change({ read: [] }),
            },
          ]),
      ...(this.filters.repos.length === 0
        ? []
        : [
            {
              label:
                this.filters.repos.length === 1
                  ? titleOf(this.filters.repos[0] ?? "", this.titles)
                  : plural(
                      this.filters.repos.length,
                      "repository",
                      "repositories",
                    ),
              off: () => this.#change({ repos: [] }),
            },
          ]),
    ];

    return chips.length === 0
      ? nothing
      : html`<gw-row class="on" gap="s">
          ${chips.map(
            (chip) =>
              html`<gw-button
                size="xs"
                appearance="outlined"
                variant="neutral"
                icon=${mdiClose}
                label=${`Remove ${chip.label}`}
                @click=${chip.off}
                >${chip.label}</gw-button
              >`,
          )}
        </gw-row>`;
  }

  override render() {
    const on =
      (this.filters.read.length === 0 ? 0 : 1) +
      (this.filters.repos.length === 0 ? 0 : 1);

    const counted = this.entries.filter((entry) =>
      matchesRest(entry, this.filters),
    );

    return html`
      <div class="bar">
        <div class="tabs">
          <gw-segmented
            size="small"
            label="Kind"
            value=${this.filters.kind}
            .options=${kindTabs.map((tab) => ({
              value: tab.value,
              label: `${tab.label} ${counted.filter((entry) => matchesKind(entry, tab.value)).length}`,
              hint: tab.description,
            }))}
            @change=${(event: Event) => {
              const value =
                event.currentTarget instanceof GwSegmented
                  ? event.currentTarget.value
                  : "";

              if (isKindFilter(value)) this.#change({ kind: value });
            }}
          ></gw-segmented>
        </div>
        <gw-button
          appearance=${on > 0 ? "accent" : "outlined"}
          variant=${on > 0 ? "brand" : "neutral"}
          icon=${mdiFilterVariant}
          @click=${() => this.#sheet?.toggle()}
          >${on > 0 ? `Filters (${on})` : "Filters"}</gw-button
        >
      </div>
      <p class="explain">
        ${kindTabs.find((tab) => tab.value === this.filters.kind)?.description}
      </p>
      ${this.#onChips()}
      <gw-sheet
        heading="Filters"
        ${ref((element) => {
          this.#sheet = element instanceof GwSheet ? element : undefined;
        })}
      >
        <gw-filter
          label="Read"
          .options=${this.#readOptions()}
          .value=${this.filters.read}
          @change=${(event: Event) =>
            this.#change({ read: filterValue(event) })}
        ></gw-filter>
        <gw-filter
          label="Repositories"
          icon=${mdiSourceRepository}
          search-label="Search repositories"
          .options=${this.#repoOptions()}
          .value=${this.filters.repos}
          @change=${(event: Event) =>
            this.#change({ repos: filterValue(event) })}
        ></gw-filter>
      </gw-sheet>
      <span class="visually-hidden" aria-live="polite"
        >${plural(this.entries.filter((entry) => matches(entry, this.filters)).length, "entry", "entries")}
        shown</span
      >
    `;
  }
}

customElements.define("upkeep-filters", UpkeepFilters);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-filters": UpkeepFilters;
  }
}
