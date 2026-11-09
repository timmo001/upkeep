/**
 * `upkeep-inbox`: the home page. A summary of what's new since the inbox was
 * last read, what needs a person with the button that settles it, then what
 * changed: kinds as tabs, each explained, the other filters in a sheet, and
 * a feed windowed so it stays quick however long it gets. Built from
 * groundwork's components.
 */
import { Domain } from "@upkeep/api";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement, nothing } from "lit";
import { always, AtomController, registry } from "./AtomController.ts";
import { plural, summarise, titlesOf, type Titles } from "./entries.ts";
import {
  phArrowRight,
  phCheckCircle,
  phChecks,
  phClockCounterClockwise,
  phPlayPause,
  phX,
} from "./icons.ts";
import { empty, jobName, shared, time, view } from "./ui.ts";
import { type Filters, matches, noFilters } from "./upkeep-filters.ts";
import {
  dismissEntry,
  inbox,
  jobHref,
  jobs,
  markRead,
  repos,
  runHref,
  unparkJob,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-alert.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/gw-card.ts";
import "@timmo001/groundwork-ui/define/gw-chip.ts";
import "@timmo001/groundwork-ui/define/gw-page-header.ts";
import "@timmo001/groundwork-ui/define/gw-section-title.ts";
import "@timmo001/groundwork-ui/define/layout.ts";
import "./upkeep-feed.ts";
import "./upkeep-filters.ts";
import "./upkeep-summary.ts";

export class UpkeepInbox extends LitElement {
  static override styles = [
    shared,
    css`
      .tldr p {
        margin: 0;
        font-size: var(--gw-font-size-l);
        line-height: 1.6;
      }

      .tldr gw-row {
        margin-top: var(--gw-space-3);
      }

      .when {
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }

      gw-button a {
        color: inherit;
        text-decoration: none;
      }
    `,
  ];

  readonly #inbox = new AtomController(this, () => inbox, always);

  readonly #jobs = new AtomController(this, () => jobs);

  readonly #repos = new AtomController(this, () => repos);

  #filters: Filters = noFilters;

  #titles(): Titles {
    const result = this.#repos.value;

    return AsyncResult.isSuccess(result) ? titlesOf(result.value) : new Map();
  }

  /** The jobs that are parked, so a parked job's entry offers to unpark it. */
  #parked() {
    const result = this.#jobs.value;

    return new Set(
      AsyncResult.isSuccess(result)
        ? result.value.filter((job) => job.parked !== null).map((job) => job.id)
        : [],
    );
  }

  #needs(entry: Domain.Entry, parked: ReadonlySet<string>) {
    const job = entry.job;

    return html`<gw-alert tone="warning" heading=${entry.title}>
      ${entry.detail ?? ""}
      <div class="when">
        ${entry.count > 1 ? `${entry.count} times, last ` : ""}${time(entry.lastAt)}
      </div>
      ${
        job !== null && parked.has(job)
          ? html`<gw-button
              slot="actions"
              size="small"
              appearance="filled"
              variant="warning"
              icon=${phPlayPause}
              @click=${() => registry.set(unparkJob, job)}
              >Unpark ${jobName(job)}</gw-button
            >`
          : nothing
      }
      ${
        entry.run === null
          ? job === null
            ? nothing
            : html`<gw-button
                slot="actions"
                size="small"
                appearance="outlined"
                variant="neutral"
                icon=${phClockCounterClockwise}
                ><a href=${jobHref(job)}>Runs</a></gw-button
              >`
          : html`<gw-button
              slot="actions"
              size="small"
              appearance="outlined"
              variant="neutral"
              icon=${phArrowRight}
              ><a href=${runHref(entry.run)}>Open the run</a></gw-button
            >`
      }
      <gw-button
        slot="actions"
        size="small"
        appearance="plain"
        variant="neutral"
        icon=${phX}
        @click=${() => registry.set(dismissEntry, entry.id)}
        >Dismiss</gw-button
      >
    </gw-alert>`;
  }

  #render(box: Domain.Inbox) {
    const titles = this.#titles();
    const parked = this.#parked();
    const needs = box.entries.filter((entry) => entry.kind === "needs");
    const others = box.entries.filter((entry) => entry.kind !== "needs");
    const worth = others.filter(Domain.worthReading);
    const routine = others.filter((entry) => entry.routine);
    const fresh = others.filter((entry) => entry.readAt === null);
    const unread = worth.filter((entry) => entry.readAt === null).length;
    const shown = others.filter((entry) => matches(entry, this.#filters));

    const touched = new Set(
      others.flatMap((entry) =>
        entry.items.map((item) => item.repo.toLowerCase()),
      ),
    );

    return html`
      <gw-stack gap="l">
        <gw-page-header
          heading="Inbox"
          description=${
            unread === 0
              ? "You're up to date"
              : `${plural(unread, "change")} to read since you last looked`
          }
        >
          ${
            fresh.length === 0
              ? nothing
              : html`<gw-button
                  slot="actions"
                  appearance="outlined"
                  variant="neutral"
                  icon=${phChecks}
                  @click=${() => registry.set(markRead, undefined)}
                  >Mark all read</gw-button
                >`
          }
        </gw-page-header>

        <gw-card class="tldr">
          <p>
            ${
              fresh.length === 0 && needs.length === 0
                ? "Nothing new since you last looked."
                : summarise(fresh, needs.length, titles)
            }
          </p>
          <gw-row gap="s">
            <gw-chip size="small" tone="accent"
              >${plural(worth.length, "change")} worth reading</gw-chip
            >
            <gw-chip size="small" tone="success"
              >${plural(routine.length, "version bump")}, no code
              changed</gw-chip
            >
            <gw-chip size="small"
              >${plural(touched.size, "repository", "repositories")}</gw-chip
            >
          </gw-row>
          <upkeep-summary></upkeep-summary>
        </gw-card>

        ${
          needs.length === 0
            ? nothing
            : html`<gw-stack>
                <gw-section-title>Needs you</gw-section-title>
                ${needs.map((entry) => this.#needs(entry, parked))}
              </gw-stack>`
        }

        <gw-stack>
          <gw-section-title>What changed</gw-section-title>
          <upkeep-filters
            .entries=${others}
            .titles=${titles}
            .filters=${this.#filters}
            @filters-change=${(event: CustomEvent<Filters>) => {
              this.#filters = event.detail;
              this.requestUpdate();
            }}
          ></upkeep-filters>
          ${
            shown.length === 0
              ? empty(phCheckCircle, "Nothing here with these filters.")
              : html`<upkeep-feed
                  storage-key="upkeep.inbox.days"
                  .entries=${shown}
                  .titles=${titles}
                ></upkeep-feed>`
          }
        </gw-stack>
      </gw-stack>
    `;
  }

  override render() {
    return view(this.#inbox.value, (box) => this.#render(box));
  }
}

customElements.define("upkeep-inbox", UpkeepInbox);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-inbox": UpkeepInbox;
  }
}
