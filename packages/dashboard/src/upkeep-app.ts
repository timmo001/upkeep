/**
 * `upkeep-app`: the dashboard's frame, a header with the menu, the server's
 * version and sign out, and the page the route picks.
 */
import { mdiLogout } from "@mdi/js";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement } from "lit";
import { AtomController, registry } from "./AtomController.ts";
import { icon, shared } from "./ui.ts";
import {
  homeHref,
  inbox,
  jobsHref,
  Route,
  route,
  serverVersion,
  token,
} from "./upkeep.ts";
import "./upkeep-inbox.ts";
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

      header {
        gap: var(--gw-space-5);
      }

      .brand {
        display: flex;
        align-items: baseline;
        gap: var(--gw-space-2);
      }

      .brand a {
        color: inherit;
        font-weight: var(--gw-font-weight-strong);
        text-decoration: none;
      }

      nav {
        display: flex;
        gap: var(--gw-space-1);
      }

      nav a {
        display: flex;
        align-items: center;
        gap: var(--gw-space-2);
        padding: var(--gw-space-1) var(--gw-space-3);
        border-radius: var(--gw-space-2);
        color: var(--gw-color-text-secondary);
        text-decoration: none;
      }

      nav a[aria-current="page"] {
        background: var(--gw-color-surface-lower);
        color: var(--gw-color-text-primary);
      }

      .count {
        min-width: 1.25rem;
        padding: 0 var(--gw-space-1);
        border-radius: 999px;
        background: var(--gw-color-link);
        color: var(--gw-color-surface-default);
        font-size: var(--gw-font-size-s);
        font-weight: var(--gw-font-weight-strong);
        text-align: center;
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

  readonly #inbox = new AtomController(this, () => inbox);

  /** How many entries are unread, for the menu. */
  #unread() {
    const result = this.#inbox.value;

    return AsyncResult.isSuccess(result)
      ? result.value.entries.filter(
          (entry) => entry.readAt === null && !entry.routine,
        ).length
      : 0;
  }

  override render() {
    const current = this.#route.value;
    const onJobs = !Route.$is("Inbox")(current);
    const unread = this.#unread();

    return html`
      <header>
        <span class="brand">
          <a href=${homeHref}>Upkeep</a>
          ${
            AsyncResult.isSuccess(this.#version.value)
              ? html`<span class="muted"
                  >${this.#version.value.value.version}</span
                >`
              : null
          }
        </span>
        <nav>
          <a href=${homeHref} aria-current=${onJobs ? "false" : "page"}
            >Inbox${
              unread === 0 ? null : html`<span class="count">${unread}</span>`
            }</a
          >
          <a href=${jobsHref} aria-current=${onJobs ? "page" : "false"}>Jobs</a>
        </nav>
        ${
          this.#token.value === ""
            ? null
            : html`<button @click=${this.#signOut}>
                ${icon(mdiLogout)} Sign out
              </button>`
        }
      </header>
      <main>
        ${Route.$match(current, {
          Inbox: () => html`<upkeep-inbox></upkeep-inbox>`,
          Jobs: () => html`<upkeep-overview></upkeep-overview>`,
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
