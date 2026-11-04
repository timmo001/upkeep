/**
 * `upkeep-feed`: inbox entries by day, as one list windowed with TanStack
 * Virtual, so only the rows on screen are drawn however long it gets. Each
 * entry is a groundwork expansion panel saying what it did; its commits are
 * only drawn once it's opened, which also marks it read.
 */
import { WindowVirtualizerController } from "@tanstack/lit-virtual";
import type { Domain } from "@upkeep/api";
import { css, html, LitElement, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { registry } from "./AtomController.ts";
import {
  dayOf,
  describe,
  fixesOf,
  kinds,
  plural,
  titleOf,
  type Titles,
} from "./entries.ts";
import { externalLink, shared, time } from "./ui.ts";
import { markRead } from "./upkeep.ts";
import "@timmo001/groundwork-ui/gw-chip.ts";
import "@timmo001/groundwork-ui/gw-dot.ts";
import "@timmo001/groundwork-ui/gw-expansion.ts";
import "@timmo001/groundwork-ui/layout.ts";

type Row =
  | { readonly kind: "day"; readonly key: string; readonly day: string }
  | {
      readonly kind: "entry";
      readonly key: string;
      readonly entry: Domain.Entry;
    };

/** Day headings before each day's entries, newest first. */
const rowsOf = (entries: ReadonlyArray<Domain.Entry>) => {
  const rows: Array<Row> = [];
  let last = "";

  for (const entry of entries) {
    const day = dayOf(entry.lastAt);

    if (day !== last) {
      rows.push({ kind: "day", key: `day:${day}`, day });
      last = day;
    }

    rows.push({ kind: "entry", key: entry.id, entry });
  }

  return rows;
};

export class UpkeepFeed extends LitElement {
  static override properties = {
    entries: { attribute: false },
    titles: { attribute: false },
  };

  static override styles = [
    shared,
    css`
      .day {
        padding: var(--gw-space-5) 0 var(--gw-space-2);
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
        font-weight: var(--gw-font-weight-strong);
      }

      .entry {
        padding-bottom: var(--gw-space-2);
      }

      .read::part(heading) {
        font-weight: normal;
        color: var(--gw-color-text-secondary);
      }

      .items {
        margin: var(--gw-space-2) 0 0;
        padding: 0;
        list-style: none;
        font-size: var(--gw-font-size-s);
      }

      .items li {
        display: flex;
        flex-wrap: wrap;
        gap: var(--gw-space-2);
        align-items: baseline;
        padding: var(--gw-space-1) 0;
      }

      .items li + li {
        border-top: 1px dashed var(--gw-color-border-quiet);
      }

      .when {
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }
    `,
  ];

  declare entries: ReadonlyArray<Domain.Entry>;

  declare titles: Titles;

  /** The entries opened, whose commits are drawn. */
  readonly #open = new Set<string>();

  readonly #virtualizer = new WindowVirtualizerController<HTMLDivElement>(
    this,
    { count: 0, estimateSize: () => 72, overscan: 8 },
  );

  constructor() {
    super();
    this.entries = [];
    this.titles = new Map();
  }

  #toggle(entry: Domain.Entry, event: Event) {
    const open =
      event.currentTarget instanceof HTMLElement &&
      event.currentTarget.hasAttribute("open");

    if (open) this.#open.add(entry.id);
    else this.#open.delete(entry.id);

    if (open && entry.readAt === null) registry.set(markRead, [entry.id]);

    this.requestUpdate();
  }

  #entry(entry: Domain.Entry) {
    const { heading, description } = describe(entry, this.titles);
    const kind = kinds[entry.kind];
    const unread = entry.readAt === null;
    const open = this.#open.has(entry.id);
    const fixes = fixesOf(entry);

    return html`<gw-expansion
      class=${unread ? "" : "read"}
      heading=${heading}
      description=${description}
      ?open=${open}
      @toggle=${(event: Event) => this.#toggle(entry, event)}
    >
      <gw-dot
        slot="icon"
        tone=${unread ? "accent" : "neutral"}
        label=${unread ? "Unread" : "Read"}
      ></gw-dot>
      ${
        open
          ? html`<gw-row gap="s">
                <gw-chip size="xs" tone=${entry.you ? "accent" : kind.tone}
                  >${entry.you ? "You" : kind.label}</gw-chip
                >
                ${
                  fixes.length > 0
                    ? html`<gw-chip size="xs" tone="success"
                        >${plural(fixes.length, "fix", "fixes")} by
                        Upkeep</gw-chip
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
              </gw-row>
              <ul class="items">
                ${entry.items.toReversed().map(
                  (item) =>
                    html`<li>
                      <gw-chip size="xs"
                        >${titleOf(item.repo, this.titles)}</gw-chip
                      >
                      ${item.url === null ? item.text : externalLink(item.url, item.text)}
                      <span class="when">${time(item.at)}</span>
                    </li>`,
                )}
              </ul>`
          : nothing
      }
    </gw-expansion>`;
  }

  override render() {
    const rows = rowsOf(this.entries);
    const virtualizer = this.#virtualizer.getVirtualizer();

    virtualizer.setOptions({
      ...virtualizer.options,
      count: rows.length,
      getItemKey: (index) => rows[index]?.key ?? index,
      // Where the list starts on the page, which the window scrolls past
      scrollMargin: this.getBoundingClientRect().top + window.scrollY,
    });

    const items = virtualizer.getVirtualItems();
    const offset = (items[0]?.start ?? 0) - virtualizer.options.scrollMargin;

    return html`<div
      style="position: relative; height: ${virtualizer.getTotalSize()}px"
    >
      <div
        style="position: absolute; inset: 0 0 auto; transform: translateY(${offset}px)"
      >
        ${repeat(
          items,
          (item) => item.key,
          (item) => {
            const row = rows[item.index];

            if (row === undefined) return nothing;

            return html`<div
              data-index=${item.index}
              class=${row.kind}
              ${ref((element) => {
                if (element instanceof HTMLDivElement) {
                  virtualizer.measureElement(element);
                }
              })}
            >
              ${row.kind === "day" ? row.day : this.#entry(row.entry)}
            </div>`;
          },
        )}
      </div>
    </div>`;
  }
}

customElements.define("upkeep-feed", UpkeepFeed);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-feed": UpkeepFeed;
  }
}
