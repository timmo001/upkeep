/**
 * `upkeep-attention`: what needs you on GitHub, in place of a daily brief.
 * What moved since you last looked comes first, then pull requests and issues
 * by section: what needs you, what's blocked, what's going stale and what
 * waits on others, with the rest folded away under Watching. A filter splits
 * work from personal, defaulting by whether it's work time. Opening the page
 * notes the visit and queues a collection when the last one is old.
 */
import {
  mdiBellOutline,
  mdiCheckCircleOutline,
  mdiEmailOpenOutline,
  mdiEyeOffOutline,
  mdiEyeOutline,
  mdiRecordCircleOutline,
  mdiRefresh,
  mdiSourcePull,
} from "@mdi/js";
import { Domain } from "@upkeep/api";
import { GwSegmented } from "@timmo001/groundwork-ui/gw-segmented.ts";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement, nothing } from "lit";
import { always, AtomController, registry } from "./AtomController.ts";
import { plural } from "./entries.ts";
import { empty, externalLink, icon, shared, time, view } from "./ui.ts";
import {
  attention,
  hideAttention,
  jobs,
  markNotificationRead,
  openAttention,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/gw-button.ts";
import "@timmo001/groundwork-ui/gw-card.ts";
import "@timmo001/groundwork-ui/gw-chip.ts";
import "@timmo001/groundwork-ui/gw-expansion.ts";
import "@timmo001/groundwork-ui/gw-page-header.ts";
import "@timmo001/groundwork-ui/gw-section-title.ts";
import "@timmo001/groundwork-ui/layout.ts";

type Scope = "work" | "personal" | "all";

const scopes: ReadonlyArray<{ readonly value: Scope; readonly label: string }> =
  [
    { value: "work", label: "Work" },
    { value: "personal", label: "Personal" },
    { value: "all", label: "All" },
  ];

const isScope = (value: string): value is Scope =>
  scopes.some((scope) => scope.value === value);

/** The sections in the order they show, each with what it means. */
const sections: ReadonlyArray<{
  readonly id: Exclude<Domain.AttentionSection, "backlog" | "watching">;
  readonly heading: string;
  readonly description: string;
}> = [
  {
    id: "needs-you",
    heading: "Needs you",
    description:
      "Reviews asked of you, changes requested, replies and mentions",
  },
  {
    id: "blocked",
    heading: "Blocked",
    description:
      "Your pull requests with failing checks, conflicts, a moved base, or an Upkeep run waiting",
  },
  {
    id: "stale",
    heading: "Going stale",
    description:
      "Yours, where others took part, with no activity from anyone lately",
  },
  {
    id: "waiting",
    heading: "Waiting on others",
    description: "Yours, where others took part and the next move is theirs",
  },
];

/** The sections folded away, with what each means. */
const folded: ReadonlyArray<{
  readonly id: Extract<Domain.AttentionSection, "backlog" | "watching">;
  readonly heading: string;
  readonly description: string;
}> = [
  {
    id: "backlog",
    heading: "Your backlog",
    description: "Your drafts, and your issues nobody else has taken part in",
  },
  {
    id: "watching",
    heading: "Watching",
    description:
      "Open on tracked repositories or involving you, with nothing asked of you",
  },
];

const tones: Record<Domain.SignalKind, string> = {
  "review-requested": "accent",
  "changes-requested": "warning",
  unresolved: "warning",
  "new-comment": "accent",
  mentioned: "accent",
  "failing-checks": "danger",
  conflicts: "danger",
  "base-moved": "warning",
  upkeep: "warning",
  approved: "success",
  draft: "neutral",
  unread: "info",
};

const kindIcons: Record<Domain.AttentionKind, string> = {
  pull: mdiSourcePull,
  issue: mdiRecordCircleOutline,
  notification: mdiBellOutline,
};

const inScope = (work: boolean, scope: Scope) =>
  scope === "all" || (scope === "work") === work;

/** Most recent first, except stale items, which show the longest quiet first. */
const order = (section: Domain.AttentionSection) =>
  section === "stale"
    ? (a: Domain.AttentionItem, b: Domain.AttentionItem) =>
        a.activityAt - b.activityAt
    : (a: Domain.AttentionItem, b: Domain.AttentionItem) =>
        b.activityAt - a.activityAt;

/** How many of each section's changes show before the rest fold away. */
const maxChanges = 15;

export class UpkeepAttention extends LitElement {
  static override styles = [
    shared,
    css`
      .when,
      .meta {
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }

      ul {
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .items li,
      .changes li {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--gw-space-1) var(--gw-space-3);
        padding: var(--gw-space-3) 0;
      }

      .items li + li,
      .changes li + li {
        border-top: 1px dashed var(--gw-color-border-quiet);
      }

      .items li > .icon,
      .changes li > .icon {
        margin-top: 0.2em;
        color: var(--gw-color-text-secondary);
      }

      .items li.moved > .icon {
        color: var(--gw-color-accent);
      }

      .title {
        font-weight: var(--gw-font-weight-strong);
      }

      .body {
        display: flex;
        flex-direction: column;
        gap: var(--gw-space-1);
        min-width: 0;
      }

      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: var(--gw-space-2);
        align-items: center;
      }

      .description {
        margin: 0;
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }

      .gone {
        text-decoration: line-through;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--gw-space-1);
      }
    `,
  ];

  readonly #attention = new AtomController(this, () => attention, always);

  readonly #jobs = new AtomController(this, () => jobs, always);

  /** The scope picked, or none to follow work time. */
  #scope: Scope | undefined;

  override connectedCallback() {
    super.connectedCallback();
    registry.set(openAttention, undefined);
  }

  /** Whether the attention job is queued or running now. */
  #collecting() {
    const result = this.#jobs.value;

    if (!AsyncResult.isSuccess(result)) return false;

    const state = result.value.find((job) => job.id === "attention")?.lastRun
      ?.state;

    return state === "queued" || state === "running";
  }

  #signals(item: Domain.AttentionItem) {
    return item.signals.map(
      (signal) =>
        html`<gw-chip size="xs" tone=${tones[signal.kind]}
          >${Domain.signalLabel(signal.kind)}${
            signal.detail === null ? nothing : html` (${signal.detail})`
          }</gw-chip
        >`,
    );
  }

  #item(item: Domain.AttentionItem, since: number | null) {
    const moved = since !== null && item.changedAt > since;

    return html`<li class=${moved ? "moved" : ""}>
      ${icon(kindIcons[item.kind])}
      <div class="body">
        <span class="title">${externalLink(item.url, item.title)}</span>
        <div class="meta">
          <span
            >${item.repo}${item.number === null ? "" : `#${item.number}`}</span
          >
          ${
            item.yours || item.author === null
              ? nothing
              : html`<span>by ${item.author}</span>`
          }
          <span>active ${time(item.activityAt)}</span>
          ${moved ? html`<gw-chip size="xs" tone="accent">Moved</gw-chip>` : nothing}
          ${this.#signals(item)}
        </div>
        <div class="actions">
          ${
            item.notification?.unread === true
              ? html`<gw-button
                  size="xs"
                  appearance="plain"
                  variant="neutral"
                  icon=${mdiEmailOpenOutline}
                  @click=${() => {
                    if (item.notification !== null) {
                      registry.set(markNotificationRead, item.notification.id);
                    }
                  }}
                  >Mark read</gw-button
                >`
              : nothing
          }
          <gw-button
            size="xs"
            appearance="plain"
            variant="neutral"
            icon=${item.hidden ? mdiEyeOutline : mdiEyeOffOutline}
            @click=${() =>
              registry.set(hideAttention, {
                url: item.url,
                hidden: !item.hidden,
              })}
            >${item.hidden ? "Show" : "Hide"}</gw-button
          >
        </div>
      </div>
    </li>`;
  }

  #changes(page: Domain.Attention, scope: Scope) {
    const work = new Map(page.items.map((item) => [item.url, item.work]));

    // A change to an item that's gone shows whatever the scope
    const changes = page.changes.filter((change) => {
      const isWork = work.get(change.url);

      return isWork === undefined || inScope(isWork, scope);
    });

    const line = (change: Domain.AttentionChange) =>
      html`<li>
        ${icon(change.gone ? mdiCheckCircleOutline : mdiRefresh)}
        <div class="body">
          <span class=${change.gone ? "title gone" : "title"}
            >${externalLink(change.url, change.title)}</span
          >
          <div class="meta">
            <span>${change.repo}</span>
            <span>${time(change.at)}</span>
            ${
              change.gone
                ? html`<gw-chip size="xs" tone="success">Gone</gw-chip>`
                : change.what.map(
                    (what) => html`<gw-chip size="xs">${what}</gw-chip>`,
                  )
            }
          </div>
        </div>
      </li>`;

    return html`<gw-card
      heading="Since you last looked"
      description=${
        page.since === null
          ? "What moved lately. Next time, this starts from this visit."
          : `What moved since ${new Date(page.since).toLocaleString()}`
      }
    >
      ${
        changes.length === 0
          ? html`<p class="description">Nothing moved.</p>`
          : html`<ul class="changes">
                ${changes.slice(0, maxChanges).map(line)}
              </ul>
              ${
                changes.length > maxChanges
                  ? html`<gw-expansion
                      heading=${`${plural(changes.length - maxChanges, "more change")}`}
                    >
                      <ul class="changes">
                        ${changes.slice(maxChanges).map(line)}
                      </ul>
                    </gw-expansion>`
                  : nothing
              }`
      }
    </gw-card>`;
  }

  #render(page: Domain.Attention) {
    const scope =
      this.#scope ??
      (page.workTime === null ? "all" : page.workTime ? "work" : "personal");

    const visible = page.items.filter((item) => !item.hidden);
    const shown = visible.filter((item) => inScope(item.work, scope));

    const hidden = page.items
      .filter((item) => item.hidden && inScope(item.work, scope))
      .toSorted((a, b) => b.activityAt - a.activityAt);

    const of = (section: Domain.AttentionSection) =>
      shown.filter((item) => item.section === section).toSorted(order(section));

    const needs = of("needs-you").length;
    const collecting = this.#collecting();

    // A refresh this soon after the last collection would queue nothing
    const minutesLeft =
      page.refreshAt === null
        ? 0
        : Math.ceil((page.refreshAt - Date.now()) / 60_000);

    return html`
      <gw-stack gap="l">
        <gw-page-header
          heading="Attention"
          description=${
            page.collectedAt === null
              ? "Nothing collected yet"
              : `${needs === 0 ? "Nothing needs you" : `${plural(needs, "item")} need you`}. Collected ${new Date(page.collectedAt).toLocaleString()}`
          }
        >
          <gw-segmented
            slot="actions"
            size="small"
            label="Scope"
            value=${scope}
            .options=${scopes.map((option) => ({
              value: option.value,
              label: `${option.label} ${
                visible.filter((item) => inScope(item.work, option.value))
                  .length
              }`,
            }))}
            @change=${(event: Event) => {
              const value =
                event.currentTarget instanceof GwSegmented
                  ? event.currentTarget.value
                  : "";

              if (isScope(value)) {
                this.#scope = value;
                this.requestUpdate();
              }
            }}
          ></gw-segmented>
          <gw-button
            slot="actions"
            appearance="outlined"
            variant="neutral"
            icon=${mdiRefresh}
            ?loading=${collecting}
            ?disabled=${collecting || minutesLeft > 0}
            @click=${() => registry.set(openAttention, undefined)}
            >${
              collecting
                ? "Collecting"
                : minutesLeft > 0
                  ? `Refresh in ${minutesLeft} min`
                  : "Refresh"
            }</gw-button
          >
        </gw-page-header>

        ${
          page.collectedAt === null
            ? empty(
                mdiRefresh,
                "The first collection is queued. Items show here once a worker sends them.",
              )
            : html`
                ${this.#changes(page, scope)}
                ${sections.map((section) => {
                  const items = of(section.id);

                  return html`<gw-stack gap="s">
                    <gw-section-title
                      >${section.heading} (${items.length})</gw-section-title
                    >
                    <p class="description">${section.description}</p>
                    ${
                      items.length === 0
                        ? nothing
                        : html`<gw-card
                            ><ul class="items">
                              ${items.map((item) => this.#item(item, page.since))}
                            </ul></gw-card
                          >`
                    }
                  </gw-stack>`;
                })}
                ${folded.map((section) => {
                  const items = of(section.id);

                  return html`<gw-expansion
                    heading=${`${section.heading} (${items.length})`}
                    description=${section.description}
                  >
                    <ul class="items">
                      ${items.map((item) => this.#item(item, page.since))}
                    </ul>
                  </gw-expansion>`;
                })}
                ${
                  hidden.length === 0
                    ? nothing
                    : html`<gw-expansion
                        heading=${`Hidden (${hidden.length})`}
                        description="Each comes back once anything about it changes"
                      >
                        <ul class="items">
                          ${hidden.map((item) => this.#item(item, page.since))}
                        </ul>
                      </gw-expansion>`
                }
              `
        }
      </gw-stack>
    `;
  }

  override render() {
    return view(
      this.#attention.value,
      (page) => this.#render(page),
      html`<gw-stack gap="l" aria-busy="true">
        <gw-page-header heading="Attention"></gw-page-header>
        <gw-card loading lines="2"></gw-card>
        ${sections.map(
          (section) =>
            html`<gw-stack gap="s">
              <gw-section-title>${section.heading}</gw-section-title>
              <gw-card loading lines="3"></gw-card>
            </gw-stack>`,
        )}
      </gw-stack>`,
    );
  }
}

customElements.define("upkeep-attention", UpkeepAttention);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-attention": UpkeepAttention;
  }
}
