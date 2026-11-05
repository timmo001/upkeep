/**
 * `upkeep-cell`: a Lit template as a `gw-table` cell. The table draws its
 * cells in its own shadow root, where the dashboard's shared styles for
 * links, muted text and icons don't reach, so each cell carries them.
 *
 * A cell can also hold its column to one size. The table only draws the rows
 * on screen and sizes its columns to them, so without that the columns
 * resize as it scrolls and as times and states change.
 */
import { css, LitElement, type TemplateResult } from "lit";
import { shared } from "./ui.ts";

/** What a cell can draw: a template, text, a list of templates, or nothing. */
export type CellContent =
  TemplateResult | string | ReadonlyArray<TemplateResult> | null;

/**
 * How a cell holds its column's size: a fixed width on one line, a fixed
 * width that wraps (for buttons), or `fill`, the spare width on one line.
 * A line that doesn't fit ends in an ellipsis, with the whole of it in the
 * tooltip.
 */
export type CellSize =
  { readonly width: string; readonly wrap?: boolean } | "fill";

export class UpkeepCell extends LitElement {
  static override properties = { content: { attribute: false } };

  static override styles = [
    shared,
    css`
      :host(.sized) {
        display: block;
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

  constructor() {
    super();
    this.content = null;
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
  } else if (size !== undefined) {
    element.classList.add("sized");

    if (!size.wrap) element.classList.add("line");
    element.style.width = size.width;
  }

  return element;
};

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-cell": UpkeepCell;
  }
}
