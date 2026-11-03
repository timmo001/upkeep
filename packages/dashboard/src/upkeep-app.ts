/**
 * `upkeep-app`: the dashboard's frame, a header with the server's version
 * and sign out, and the page the route picks.
 */
import { mdiLogout } from "@mdi/js";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement } from "lit";
import { AtomController, registry } from "./AtomController.ts";
import { icon, shared } from "./ui.ts";
import { homeHref, Route, route, serverVersion, token } from "./upkeep.ts";
import "./upkeep-job.ts";
import "./upkeep-overview.ts";
import "./upkeep-run.ts";

export class UpkeepApp extends LitElement {
  static override styles = [
    shared,
    css`
      :host {
        --upkeep-gutter: 1.5rem;
      }

      @media (max-width: 39.99rem) {
        :host {
          --upkeep-gutter: 1rem;
        }
      }

      header {
        display: flex;
        align-items: center;
        gap: var(--gw-space-3);
        padding: var(--gw-space-3) var(--upkeep-gutter);
        border-bottom: 1px solid var(--gw-color-border-quiet);
        background: var(--gw-color-surface-low);
      }

      header a {
        color: inherit;
        font-weight: var(--gw-font-weight-strong);
        text-decoration: none;
      }

      header button {
        display: flex;
        align-items: center;
        gap: var(--gw-space-2);
        margin-left: auto;
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }

      main {
        max-width: 80rem;
        margin: 0 auto;
        padding: var(--gw-space-4) var(--upkeep-gutter) 3rem;
      }
    `,
  ];

  readonly #token = new AtomController(this, () => token);

  readonly #route = new AtomController(this, () => route);

  readonly #version = new AtomController(this, () => serverVersion);

  override render() {
    return html`
      <header>
        <a href=${homeHref}>Upkeep</a>
        ${
          AsyncResult.isSuccess(this.#version.value)
            ? html`<span class="muted"
                >${this.#version.value.value.version}</span
              >`
            : null
        }
        ${
          this.#token.value === ""
            ? null
            : html`<button @click=${this.#signOut}>
                ${icon(mdiLogout)} Sign out
              </button>`
        }
      </header>
      <main>
        ${Route.$match(this.#route.value, {
          Overview: () => html`<upkeep-overview></upkeep-overview>`,
          Job: ({ id }) => html`<upkeep-job .jobId=${id}></upkeep-job>`,
          Run: ({ id }) => html`<upkeep-run .runId=${id}></upkeep-run>`,
        })}
      </main>
    `;
  }

  readonly #signOut = () => registry.set(token, "");
}

customElements.define("upkeep-app", UpkeepApp);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-app": UpkeepApp;
  }
}
