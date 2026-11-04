/**
 * `upkeep-repo`: one tracked repository's page. Its title and GitHub link,
 * the jobs it's opted into, and what changed in it from the inbox, with the
 * same kind tabs, filters and windowed feed as the inbox.
 */
import { mdiCheckCircleOutline, mdiGithub } from "@mdi/js";
import { Catalogue, type Domain } from "@upkeep/api";
import { css, html, LitElement } from "lit";
import { always, AtomController } from "./AtomController.ts";
import { titleOf, titlesOf } from "./entries.ts";
import { empty, shared, view } from "./ui.ts";
import { type Filters, matches, noFilters } from "./upkeep-filters.ts";
import { inbox, jobHref, repos } from "./upkeep.ts";
import "@timmo001/groundwork-ui/gw-button.ts";
import "@timmo001/groundwork-ui/gw-card.ts";
import "@timmo001/groundwork-ui/gw-chip.ts";
import "@timmo001/groundwork-ui/gw-page-header.ts";
import "@timmo001/groundwork-ui/gw-section-title.ts";
import "@timmo001/groundwork-ui/layout.ts";
import "./upkeep-feed.ts";
import "./upkeep-filters.ts";

export class UpkeepRepo extends LitElement {
  static override properties = {
    repo: { attribute: false },
  };

  static override styles = [
    shared,
    css`
      gw-button a,
      gw-chip a {
        color: inherit;
        text-decoration: none;
      }
    `,
  ];

  declare repo: string;

  readonly #repos = new AtomController(this, () => repos);

  readonly #inbox = new AtomController(this, () => inbox, always);

  #filters: Filters = noFilters;

  constructor() {
    super();
    this.repo = "";
  }

  #render(tracked: ReadonlyArray<Domain.TrackedRepo>, box: Domain.Inbox) {
    const name = this.repo.toLowerCase();
    const found = tracked.find((repo) => repo.repo.toLowerCase() === name);
    const titles = titlesOf(tracked);

    const touching = box.entries.filter(
      (entry) =>
        entry.kind !== "needs" &&
        entry.items.some((item) => item.repo.toLowerCase() === name),
    );

    const shown = touching.filter((entry) => matches(entry, this.#filters));
    const jobs = Catalogue.jobs.filter((job) => found?.jobs.includes(job.id));

    return html`
      <gw-stack gap="l">
        <gw-page-header
          heading=${titleOf(this.repo, titles)}
          description=${
            found === undefined ? `${this.repo}, not tracked` : this.repo
          }
        >
          <gw-button
            slot="actions"
            appearance="outlined"
            variant="neutral"
            icon=${mdiGithub}
            ><a
              href=${`https://github.com/${this.repo}`}
              target="_blank"
              rel="noopener"
              >GitHub</a
            ></gw-button
          >
        </gw-page-header>

        <gw-card heading="Jobs" description="What Upkeep runs on it">
          <gw-row gap="s">
            ${
              jobs.length === 0
                ? html`<span class="muted">None</span>`
                : jobs.map(
                    (job) =>
                      html`<gw-chip size="small"
                        ><a href=${jobHref(job.id)}>${job.name}</a></gw-chip
                      >`,
                  )
            }
          </gw-row>
        </gw-card>

        <gw-stack>
          <gw-section-title>What changed</gw-section-title>
          <upkeep-filters
            .entries=${touching}
            .titles=${titles}
            .filters=${this.#filters}
            @filters-change=${(event: CustomEvent<Filters>) => {
              this.#filters = event.detail;
              this.requestUpdate();
            }}
          ></upkeep-filters>
          ${
            shown.length === 0
              ? empty(mdiCheckCircleOutline, "Nothing here with these filters.")
              : html`<upkeep-feed
                  .entries=${shown}
                  .titles=${titles}
                ></upkeep-feed>`
          }
        </gw-stack>
      </gw-stack>
    `;
  }

  override render() {
    return view(this.#repos.value, (tracked) =>
      view(this.#inbox.value, (box) => this.#render(tracked, box)),
    );
  }
}

customElements.define("upkeep-repo", UpkeepRepo);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-repo": UpkeepRepo;
  }
}
