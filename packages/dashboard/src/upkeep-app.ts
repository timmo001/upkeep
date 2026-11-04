/**
 * `upkeep-app`: the dashboard's frame, groundwork's app bar with the brand,
 * the menu and sign out, and the page the route picks.
 */
import { mdiLogout } from "@mdi/js";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement, nothing } from "lit";
import { AtomController, registry } from "./AtomController.ts";
import { shared } from "./ui.ts";
import {
  homeHref,
  inbox,
  jobsHref,
  Route,
  route,
  serverVersion,
  token,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/gw-app-bar.ts";
import "@timmo001/groundwork-ui/gw-button.ts";
import "@timmo001/groundwork-ui/gw-chip.ts";
import "@timmo001/groundwork-ui/layout.ts";
import "./upkeep-inbox.ts";
import "./upkeep-job.ts";
import "./upkeep-overview.ts";
import "./upkeep-run.ts";

export class UpkeepApp extends LitElement {
  static override styles = [
    shared,
    css`
      .brand {
        display: flex;
        align-items: baseline;
        gap: var(--gw-space-2);
        color: inherit;
        font-weight: var(--gw-font-weight-strong);
        text-decoration: none;
        white-space: nowrap;
      }

      .brand .muted {
        font-weight: normal;
        font-size: var(--gw-font-size-s);
      }

      gw-app-bar gw-button a {
        display: inline-flex;
        align-items: center;
        gap: var(--gw-space-2);
        color: inherit;
        text-decoration: none;
      }

      main {
        padding: var(--gw-space-6) 0 var(--gw-space-12);
      }
    `,
  ];

  readonly #token = new AtomController(this, () => token);

  readonly #route = new AtomController(this, () => route);

  readonly #version = new AtomController(this, () => serverVersion);

  readonly #inbox = new AtomController(this, () => inbox);

  /** How many entries worth reading are unread, for the menu. */
  #unread() {
    const result = this.#inbox.value;

    return AsyncResult.isSuccess(result)
      ? result.value.entries.filter(
          (entry) => entry.readAt === null && !entry.routine,
        ).length
      : 0;
  }

  #link(href: string, label: string, current: boolean, count = 0) {
    return html`<gw-button appearance="plain" variant="neutral"
      ><a href=${href} aria-current=${current ? "page" : "false"}
        >${label}${
          count === 0
            ? nothing
            : html`<gw-chip size="xs" tone="accent">${count}</gw-chip>`
        }</a
      ></gw-button
    >`;
  }

  override render() {
    const current = this.#route.value;
    const onInbox = Route.$is("Inbox")(current);

    return html`
      <gw-app-bar menu-label="Pages">
        <a slot="brand" class="brand" href=${homeHref}
          >Upkeep${
            AsyncResult.isSuccess(this.#version.value)
              ? html`<span class="muted"
                  >${this.#version.value.value.version}</span
                >`
              : nothing
          }</a
        >
        ${this.#link(homeHref, "Inbox", onInbox, this.#unread())}
        ${this.#link(jobsHref, "Jobs", !onInbox)}
        ${
          this.#token.value === ""
            ? nothing
            : html`<gw-button
                slot="actions"
                appearance="plain"
                variant="neutral"
                labels="auto"
                icon=${mdiLogout}
                @click=${this.#signOut}
                >Sign out</gw-button
              >`
        }
      </gw-app-bar>
      <main>
        <gw-page>
          ${Route.$match(current, {
            Inbox: () => html`<upkeep-inbox></upkeep-inbox>`,
            Jobs: () => html`<upkeep-overview></upkeep-overview>`,
            Job: ({ id }) => html`<upkeep-job .jobId=${id}></upkeep-job>`,
            Run: ({ id }) => html`<upkeep-run .runId=${id}></upkeep-run>`,
          })}
        </gw-page>
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
