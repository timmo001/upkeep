/**
 * `upkeep-app`: the dashboard's frame, groundwork's app bar with the brand,
 * the nav, the theme picker and sign out, and the page the route picks.
 */
import { GwThemePicker } from "@timmo001/groundwork-ui/gw-theme-picker.ts";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import logo from "../favicon.svg";
import { AtomController, registry } from "./AtomController.ts";
import { phSignOut } from "./icons.ts";
import { bindTheme } from "./theme.ts";
import { shared } from "./ui.ts";
import {
  attentionHref,
  homeHref,
  inbox,
  jobsHref,
  live,
  reposHref,
  Route,
  route,
  serverVersion,
  skillsHref,
  skillsPage,
  token,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/gw-app-bar.ts";
import "@timmo001/groundwork-ui/gw-button.ts";
import "@timmo001/groundwork-ui/gw-chip.ts";
import "@timmo001/groundwork-ui/layout.ts";
import "./upkeep-attention.ts";
import "./upkeep-inbox.ts";
import "./upkeep-job.ts";
import "./upkeep-overview.ts";
import "./upkeep-repo.ts";
import "./upkeep-repos.ts";
import "./upkeep-run.ts";
import "./upkeep-skills.ts";

export class UpkeepApp extends LitElement {
  static override styles = [
    shared,
    css`
      .brand {
        display: inline-flex;
        align-items: center;
        gap: var(--gw-space-2);
        color: var(--gw-color-text-strong);
        font-weight: var(--gw-font-weight-strong);
        text-decoration: none;
        white-space: nowrap;
      }

      .brand img {
        width: 1.5rem;
        height: 1.5rem;
      }

      .brand .muted {
        font-weight: normal;
        font-size: var(--gw-font-size-s);
      }

      /* A phone's app bar has no room for the version */
      @media (max-width: 30rem) {
        .brand .muted {
          display: none;
        }
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

  readonly #skills = new AtomController(this, () => skillsPage);

  // Keeps the server's changes coming for as long as the dashboard is open
  readonly #live = new AtomController(this, () => live);

  /** How many held skill changes wait for approval, for the menu. */
  #waiting() {
    const result = this.#skills.value;

    return AsyncResult.isSuccess(result)
      ? result.value.changes.filter((change) => change.state === "waiting")
          .length
      : 0;
  }

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
    const onRepos = Route.$is("Repos")(current) || Route.$is("Repo")(current);
    const onAttention = Route.$is("Attention")(current);
    const onSkills = Route.$is("Skills")(current);

    const onJobs =
      Route.$is("Jobs")(current) ||
      Route.$is("Job")(current) ||
      Route.$is("Run")(current);

    return html`
      <gw-app-bar menu-label="Pages" menu-below="900">
        <a slot="brand" class="brand" href=${homeHref}
          ><img src=${logo} alt="" width="24" height="24" />Upkeep${
            AsyncResult.isSuccess(this.#version.value)
              ? html`<span class="muted"
                  >${this.#version.value.value.version}</span
                >`
              : nothing
          }${
            AsyncResult.isSuccess(this.#live.value) && !this.#live.value.value
              ? html`<span
                  class="muted"
                  title="Lost the server's live updates, trying again"
                  >reconnecting</span
                >`
              : nothing
          }</a
        >
        ${this.#link(homeHref, "Inbox", onInbox, this.#unread())}
        ${this.#link(attentionHref, "Attention", onAttention)}
        ${this.#link(skillsHref, "Skills", onSkills, this.#waiting())}
        ${this.#link(reposHref, "Repositories", onRepos)}
        ${this.#link(jobsHref, "Jobs", onJobs)}
        <gw-theme-picker
          slot="actions"
          no-import
          ${ref(this.#bindTheme)}
        ></gw-theme-picker>
        ${
          this.#token.value === ""
            ? nothing
            : html`<gw-button
                slot="actions"
                appearance="plain"
                variant="neutral"
                labels="auto"
                icon=${phSignOut}
                @click=${this.#signOut}
                >Sign out</gw-button
              >`
        }
      </gw-app-bar>
      <main>
        <gw-page>
          ${Route.$match(current, {
            Inbox: () => html`<upkeep-inbox></upkeep-inbox>`,
            Attention: () => html`<upkeep-attention></upkeep-attention>`,
            Skills: () => html`<upkeep-skills></upkeep-skills>`,
            Repos: () => html`<upkeep-repos></upkeep-repos>`,
            Repo: ({ repo }) => html`<upkeep-repo .repo=${repo}></upkeep-repo>`,
            Jobs: () => html`<upkeep-overview></upkeep-overview>`,
            Job: ({ id }) => html`<upkeep-job .jobId=${id}></upkeep-job>`,
            Run: ({ id }) => html`<upkeep-run .runId=${id}></upkeep-run>`,
          })}
        </gw-page>
      </main>
    `;
  }

  #bound = false;

  /** Ties the theme picker to the page's theme once, when it's first rendered. */
  readonly #bindTheme = (element: Element | undefined) => {
    if (this.#bound || !(element instanceof GwThemePicker)) return;

    this.#bound = true;
    bindTheme(element);
  };

  readonly #signOut = () => registry.set(token, "");
}

customElements.define("upkeep-app", UpkeepApp);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-app": UpkeepApp;
  }
}
