/**
 * `upkeep-cell`: a Lit template as a `gw-table` cell. The table draws its
 * cells in its own shadow root, where the dashboard's shared styles for
 * links, muted text and icons don't reach, so each cell carries them.
 *
 * A cell can also hold its column's size. The table only draws the rows on
 * screen and sizes its columns to them, so a column that fits its content
 * keeps the widest it has been, rather than shrinking and growing as the
 * table scrolls and as times and states change.
 */
import { css, LitElement, type TemplateResult } from "lit";
import { shared } from "./ui.ts";

/** What a cell can draw: a template, text, a list of templates, or nothing. */
export type CellContent =
  TemplateResult | string | ReadonlyArray<TemplateResult> | null;

/**
 * How a cell holds its column's size: `fit`, its content on one line, at the
 * widest the column has been; a fixed width that wraps, for a set of
 * buttons; or `fill`, the spare width on one line, which ends in an ellipsis
 * when it doesn't fit, with the whole of it in the tooltip.
 */
export type CellSize = "fit" | "fill" | { readonly width: string };

/** The widest each fitted column has been, by its table and its header. */
const widest = new WeakMap<Node, Map<string, number>>();

export class UpkeepCell extends LitElement {
  static override properties = { content: { attribute: false } };

  static override styles = [
    shared,
    css`
      :host(.sized) {
        display: block;
      }

      :host(.fit) {
        width: max-content;
        white-space: nowrap;
      }

      :host(.line) {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Takes the cell's width without adding its own, so a long line
         can't widen the table */
      :host(.fill) {
        width: 0;
        min-width: 100%;
      }

      /* A row link covers its whole row, from a table whose rows are
         positioned, and the cell's other links and buttons sit above it */
      a.row-link::after {
        position: absolute;
        inset: 0;
        content: "";
      }

      a:not(.row-link),
      gw-button {
        position: relative;
        z-index: 1;
      }
    `,
  ];

  declare content: CellContent;

  #observer: ResizeObserver | undefined;

  constructor() {
    super();
    this.content = null;
  }

  override connectedCallback() {
    super.connectedCallback();

    if (!this.classList.contains("fit")) return;

    this.#fit();
    this.#observer = new ResizeObserver(() => this.#fit());
    this.#observer.observe(this);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#observer?.disconnect();
    this.#observer = undefined;
  }

  /** Hold the column at the widest it has been, this cell included. */
  #fit() {
    const td = this.closest("td");
    const header = td?.closest("table")?.tHead?.rows[0]?.cells[td.cellIndex];

    if (td === null || header === undefined) return;

    const root = this.getRootNode();
    const columns = widest.get(root) ?? new Map<string, number>();
    const key = header.textContent?.trim() ?? "";
    const width = Math.max(columns.get(key) ?? 0, this.offsetWidth);

    columns.set(key, width);
    widest.set(root, columns);

    if (this.style.minWidth !== `${width}px`) {
      this.style.minWidth = `${width}px`;
    }
  }

  override render() {
    return this.content;
  }

  override updated() {
    // A line cut short shows the whole of it in its tooltip
    if (!this.classList.contains("line")) return;

    const cut = this.scrollWidth > this.clientWidth;
    const text = this.shadowRoot?.textContent?.replace(/\s+/g, " ").trim();

    if (cut && text) this.title = text;
    else this.removeAttribute("title");
  }
}

customElements.define("upkeep-cell", UpkeepCell);

/** A cell that draws a template, for a `gw-table` column's `cell`. */
export const cell = (content: CellContent, size?: CellSize) => {
  const element = new UpkeepCell();

  element.content = content;

  if (size === "fill") {
    element.classList.add("sized", "line", "fill");
  } else if (size === "fit") {
    element.classList.add("sized", "fit");
  } else if (size !== undefined) {
    element.classList.add("sized");
    element.style.width = size.width;
  }

  return element;
};

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-cell": UpkeepCell;
  }
}
