/**
 * `upkeep-cell`: a Lit template as a `gw-table` cell. The table draws its
 * cells in its own shadow root, where the dashboard's shared styles for
 * links, muted text and icons don't reach, so each cell carries them.
 */
import { css, LitElement, type TemplateResult } from "lit";
import { shared } from "./ui.ts";

/** What a cell can draw: a template, text, a list of templates, or nothing. */
export type CellContent =
  TemplateResult | string | ReadonlyArray<TemplateResult> | null;

export class UpkeepCell extends LitElement {
  static override properties = { content: { attribute: false } };

  static override styles = [
    shared,
    css`
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
}

customElements.define("upkeep-cell", UpkeepCell);

/** A cell that draws a template, for a `gw-table` column's `cell`. */
export const cell = (content: CellContent) => {
  const element = new UpkeepCell();

  element.content = content;

  return element;
};

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-cell": UpkeepCell;
  }
}
