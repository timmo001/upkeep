/**
 * `upkeep-app`: the dashboard's frame, groundwork's app bar with the brand,
 * the nav, the theme picker and sign out, and the page the route picks.
 */
import "@timmo001/groundwork-ui/define/gw-popover.ts";
import { GwPopover } from "@timmo001/groundwork-ui/gw-popover.ts";
import "@timmo001/groundwork-ui/define/gw-theme-picker.ts";
import { GwThemePicker } from "@timmo001/groundwork-ui/gw-theme-picker.ts";
import { Domain } from "@upkeep/api";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import logo from "../favicon.svg";
import { AtomController, registry } from "./AtomController.ts";
import { phSignOut } from "./icons.ts";
import { bindTheme, offerDesktopTheme } from "./theme.ts";
import { impactTone, shared } from "./ui.ts";
import {
  activityHref,
  attentionHref,
  desktopTheme,
  homeHref,
  inbox,
  jobsHref,
  live,
  releasesHref,
  releasesPage,
  reposHref,
  Route,
  route,
  serverVersion,
  skillsHref,
  skillsPage,
  token,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-app-bar.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/gw-chip.ts";
import "@timmo001/groundwork-ui/define/layout.ts";
import "./upkeep-activity.ts";
import "./upkeep-attention.ts";
import "./upkeep-inbox.ts";
import "./upkeep-job.ts";
import "./upkeep-overview.ts";
import "./upkeep-releases.ts";
import "./upkeep-repo.ts";
import "./upkeep-repos.ts";
import "./upkeep-run.ts";
import "./upkeep-skills.ts";

/** A count beside a menu link, in its own colour, and what it counts. */
interface Badge {
  readonly count: number;
  readonly tone: string;
  readonly label: string;
}

/** One plain count, for a link with nothing to tell apart. */
const counted = (count: number): ReadonlyArray<Badge> => [
  { count, tone: "accent", label: "" },
];

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

      /* The picker takes the room it would need for every control, so keep
         what it shows at its end, beside Sign out */
      gw-app-bar gw-theme-picker {
        justify-content: flex-end;
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

  readonly #releases = new AtomController(this, () => releasesPage);

  readonly #desktopTheme = new AtomController(this, () => desktopTheme);

  // Keeps the server's changes coming for as long as the dashboard is open
  readonly #live = new AtomController(this, () => live);

  override willUpdate() {
    const result = this.#desktopTheme.value;

    if (AsyncResult.isSuccess(result)) offerDesktopTheme(result.value.theme);
  }

  /** How many held skill changes wait for approval, for the menu. */
  #waiting() {
    const result = this.#skills.value;

    return AsyncResult.isSuccess(result)
      ? result.value.changes.filter((change) => change.state === "waiting")
          .length
      : 0;
  }

  /**
   * How many repositories have changes worth a release, by the release they
   * suggest, biggest first, for the menu.
   */
  #unreleased(): ReadonlyArray<Badge> {
    const result = this.#releases.value;

    if (!AsyncResult.isSuccess(result)) return [];

    const due = result.value.repos.filter((entry) => entry.needsRelease);

    return (["major", "minor", "patch"] as const).map((impact) => ({
      count: due.filter((entry) => entry.snapshot?.suggestion === impact)
        .length,
      tone: impactTone[impact],
      label: impact,
    }));
  }

  /** How many entries worth reading are unread, for the menu. */
  #unread() {
    const result = this.#inbox.value;

    return AsyncResult.isSuccess(result)
      ? result.value.entries.filter(
          (entry) => entry.readAt === null && Domain.worthReading(entry),
        ).length
      : 0;
  }

  #link(
    href: string,
    label: string,
    current: boolean,
    badges: ReadonlyArray<Badge> = [],
  ) {
    return html`<gw-button appearance="plain" variant="neutral"
      ><a href=${href} aria-current=${current ? "page" : "false"}
        >${label}${badges.flatMap((badge) =>
          badge.count === 0
            ? []
            : [
                html`<gw-chip
                  size="xs"
                  tone=${badge.tone}
                  title=${badge.label === "" ? nothing : `${badge.count} ${badge.label}`}
                  >${badge.count}</gw-chip
                >`,
              ],
        )}</a
      ></gw-button
    >`;
  }

  override render() {
    const current = this.#route.value;
    const onInbox = Route.$is("Inbox")(current);
    const onActivity = Route.$is("Activity")(current);
    const onRepos = Route.$is("Repos")(current) || Route.$is("Repo")(current);
    const onAttention = Route.$is("Attention")(current);
    const onSkills = Route.$is("Skills")(current);

    const onReleases =
      Route.$is("Releases")(current) || Route.$is("Release")(current);

    const onJobs =
      Route.$is("Jobs")(current) ||
      Route.$is("Job")(current) ||
      Route.$is("Run")(current);

    return html`
      <gw-app-bar size="wide" menu-label="Pages" menu-below="900">
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
        ${this.#link(homeHref, "Inbox", onInbox, counted(this.#unread()))}
        ${this.#link(activityHref, "Activity", onActivity)}
        ${this.#link(attentionHref, "Attention", onAttention)}
        ${this.#link(skillsHref, "Skills", onSkills, counted(this.#waiting()))}
        ${this.#link(releasesHref, "Releases", onReleases, this.#unreleased())}
        ${this.#link(reposHref, "Repositories", onRepos)}
        ${this.#link(jobsHref, "Jobs", onJobs)}
        <gw-theme-picker
          slot="actions"
          no-import
          no-reset
          ${ref(this.#bindTheme)}
        ></gw-theme-picker>
        ${
          this.#token.value === ""
            ? nothing
            : html`<gw-button
                slot="actions"
                appearance="plain"
                variant="neutral"
                labels="hide"
                label="Sign out"
                icon=${phSignOut}
                @click=${(event: Event) =>
                  this.#signOutPopover?.show(
                    event.currentTarget instanceof Element
                      ? event.currentTarget
                      : undefined,
                  )}
                >Sign out</gw-button
              >`
        }
      </gw-app-bar>
      <gw-popover
        heading="Sign out?"
        confirm
        ${ref((element) => {
          this.#signOutPopover =
            element instanceof GwPopover ? element : undefined;
        })}
        @close=${this.#signOut}
      >
        <p>You'll need the admin token to sign back in.</p>
        <gw-button
          slot="actions"
          size="small"
          appearance="plain"
          variant="neutral"
          value="cancel"
          >Cancel</gw-button
        >
        <gw-button
          slot="actions"
          size="small"
          variant="danger"
          value="sign-out"
          icon=${phSignOut}
          >Sign out</gw-button
        >
      </gw-popover>
      <main>
        <gw-page size="wide">
          ${Route.$match(current, {
            Inbox: () => html`<upkeep-inbox></upkeep-inbox>`,
            Activity: () => html`<upkeep-activity></upkeep-activity>`,
            Attention: () => html`<upkeep-attention></upkeep-attention>`,
            Skills: () => html`<upkeep-skills></upkeep-skills>`,
            Releases: () => html`<upkeep-releases></upkeep-releases>`,
            Release: ({ repo }) =>
              html`<upkeep-releases .repo=${repo}></upkeep-releases>`,
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

  #signOutPopover: GwPopover | undefined;

  /** Signs out once the confirmation's Sign out closed it. */
  readonly #signOut = () => {
    if (this.#signOutPopover?.returnValue === "sign-out")
      registry.set(token, "");
  };
}

customElements.define("upkeep-app", UpkeepApp);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-app": UpkeepApp;
  }
}
