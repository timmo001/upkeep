/**
 * `upkeep-runs-page`: the Runs page, the latest runs of every job with their
 * filters.
 */
import { css, html, LitElement } from "lit";
import { shared } from "./ui.ts";
import "@timmo001/groundwork-ui/define/gw-page-header.ts";
import "./upkeep-runs.ts";

export class UpkeepRunsPage extends LitElement {
  static override styles = [
    shared,
    css`
      gw-page-header {
        margin-bottom: var(--gw-space-4);
      }
    `,
  ];

  override render() {
    return html`
      <gw-page-header
        heading="Runs"
        description="The latest runs of every job, and how each went"
      ></gw-page-header>
      <upkeep-runs></upkeep-runs>
    `;
  }
}

customElements.define("upkeep-runs-page", UpkeepRunsPage);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-runs-page": UpkeepRunsPage;
  }
}
