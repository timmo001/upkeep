/**
 * `upkeep-repo`: one tracked repository's page. Its name, a way to rename
 * it, its GitHub link, the jobs it's opted into, and what changed in it from
 * the inbox, with the same kind tabs, filters and windowed feed as the inbox.
 */
import "@timmo001/groundwork-ui/define/gw-input.ts";
import { GwInput } from "@timmo001/groundwork-ui/gw-input.ts";
import "@timmo001/groundwork-ui/define/gw-popover.ts";
import { GwPopover } from "@timmo001/groundwork-ui/gw-popover.ts";
import { Catalogue, type Domain } from "@upkeep/api";
import { css, html, LitElement, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { always, AtomController, registry } from "./AtomController.ts";
import { titleOf, titlesOf } from "./entries.ts";
import {
  phArrowCounterClockwise,
  phCheck,
  phCheckCircle,
  phGithubLogo,
  phPencilSimple,
} from "./icons.ts";
import { empty, shared, view } from "./ui.ts";
import { type Filters, matches, noFilters } from "./upkeep-filters.ts";
import { inbox, jobHref, renameRepo, repos } from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/gw-card.ts";
import "@timmo001/groundwork-ui/define/gw-chip.ts";
import "@timmo001/groundwork-ui/define/gw-page-header.ts";
import "@timmo001/groundwork-ui/define/gw-section-title.ts";
import "@timmo001/groundwork-ui/define/layout.ts";
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

  #rename: GwPopover | undefined;

  #name: GwInput | undefined;

  constructor() {
    super();
    this.repo = "";
  }

  /** Save the name typed, clear it, or do nothing, as the popover closed. */
  #renamed(found: Domain.TrackedRepo) {
    const action = this.#rename?.returnValue ?? "";

    if (action === "save") {
      const name = this.#name?.value.trim() ?? "";

      registry.set(renameRepo, {
        repo: found.repo,
        name: name === "" ? null : name,
      });
    }

    if (action === "reset") {
      registry.set(renameRepo, { repo: found.repo, name: null });
    }
  }

  /** The Rename button, in the page header's actions, opening on the current name. */
  #renameButton(found: Domain.TrackedRepo) {
    return html`<gw-button
      slot="actions"
      appearance="outlined"
      variant="neutral"
      icon=${phPencilSimple}
      @click=${(event: Event) => {
        if (this.#name !== undefined) {
          this.#name.value = found.name ?? found.title ?? "";
        }

        this.#rename?.show(
          event.currentTarget instanceof Element
            ? event.currentTarget
            : undefined,
        );
      }}
      >Rename</gw-button
    >`;
  }

  /**
   * The popover Rename opens, outside the page header, whose unslotted
   * children never show.
   */
  #renamePopover(found: Domain.TrackedRepo) {
    const hint =
      found.namedBy === "worker"
        ? "Named by a worker from its names setting. A name you set here stays."
        : "Leave it empty to show the README's title.";

    return html`<gw-popover
      heading="Rename repository"
      ${ref((element) => {
        this.#rename = element instanceof GwPopover ? element : undefined;
      })}
      @close=${() => this.#renamed(found)}
    >
      <gw-input
        label="Name"
        hint=${hint}
        ${ref((element) => {
          this.#name = element instanceof GwInput ? element : undefined;
        })}
      ></gw-input>
      ${
        found.namedBy === "you"
          ? html`<gw-button
              slot="actions"
              size="small"
              appearance="plain"
              variant="neutral"
              value="reset"
              icon=${phArrowCounterClockwise}
              >Reset</gw-button
            >`
          : nothing
      }
      <gw-button
        slot="actions"
        size="small"
        value="save"
        icon=${phCheck}
        data-needs-changes
        >Save</gw-button
      >
    </gw-popover>`;
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
          ${found === undefined ? nothing : this.#renameButton(found)}
          <gw-button
            slot="actions"
            appearance="outlined"
            variant="neutral"
            icon=${phGithubLogo}
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
              ? empty(phCheckCircle, "Nothing here with these filters.")
              : html`<upkeep-feed
                  storage-key="upkeep.repo.days"
                  .entries=${shown}
                  .titles=${titles}
                ></upkeep-feed>`
          }
        </gw-stack>
      </gw-stack>
      ${found === undefined ? nothing : this.#renamePopover(found)}
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
