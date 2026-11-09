/**
 * `upkeep-repos`: every tracked repository by its title, searchable, with
 * how much is unread in it, when it last changed and the jobs it's opted
 * into. Each card opens the repository's own page.
 */
import { Domain } from "@upkeep/api";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement, nothing } from "lit";
import { always, AtomController } from "./AtomController.ts";
import { plural, titlesOf } from "./entries.ts";
import { phMagnifyingGlass } from "./icons.ts";
import { empty, shared, time, view } from "./ui.ts";
import { inbox, repoHref, repos } from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-card.ts";
import "@timmo001/groundwork-ui/define/gw-chip.ts";
import "@timmo001/groundwork-ui/define/gw-input.ts";
import { GwInput } from "@timmo001/groundwork-ui/gw-input.ts";
import "@timmo001/groundwork-ui/define/gw-page-header.ts";
import "@timmo001/groundwork-ui/define/layout.ts";

/** What the inbox holds for one repository. */
interface Activity {
  readonly unread: number;
  readonly lastAt: number | null;
}

const activityOf = (
  repo: string,
  entries: ReadonlyArray<Domain.Entry>,
): Activity => {
  const name = repo.toLowerCase();

  const touching = entries.filter((entry) =>
    entry.items.some((item) => item.repo.toLowerCase() === name),
  );

  return {
    unread: touching.filter(
      (entry) => entry.readAt === null && Domain.worthReading(entry),
    ).length,
    lastAt: touching.reduce<number | null>(
      (last, entry) => Math.max(last ?? 0, entry.lastAt),
      null,
    ),
  };
};

export class UpkeepRepos extends LitElement {
  static override styles = [
    shared,
    css`
      gw-input {
        max-width: 24rem;
      }

      .when {
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }
    `,
  ];

  readonly #repos = new AtomController(this, () => repos, always);

  readonly #inbox = new AtomController(this, () => inbox);

  #search = "";

  #render(tracked: ReadonlyArray<Domain.TrackedRepo>) {
    const titles = titlesOf(tracked);
    const box = this.#inbox.value;
    const entries = AsyncResult.isSuccess(box) ? box.value.entries : [];
    const search = this.#search.trim().toLowerCase();

    const shown = tracked
      .flatMap((repo) => {
        const title =
          titles.get(repo.repo.toLowerCase()) ??
          repo.repo.split("/")[1] ??
          repo.repo;

        const matches =
          search === "" ||
          title.toLowerCase().includes(search) ||
          repo.repo.toLowerCase().includes(search);

        return matches
          ? [{ repo, title, activity: activityOf(repo.repo, entries) }]
          : [];
      })
      .toSorted(
        (a, b) =>
          (b.activity.lastAt ?? 0) - (a.activity.lastAt ?? 0) ||
          a.title.localeCompare(b.title),
      );

    return html`
      <gw-stack gap="l">
        <gw-page-header
          heading="Repositories"
          description=${`${plural(tracked.length, "repository", "repositories")} Upkeep looks after, most recently changed first`}
        ></gw-page-header>
        <gw-input
          label="Search repositories"
          label-hidden
          placeholder="Search repositories"
          icon=${phMagnifyingGlass}
          .value=${this.#search}
          @input=${(event: Event) => {
            const target = event.currentTarget;

            this.#search = target instanceof GwInput ? target.value : "";
            this.requestUpdate();
          }}
        ></gw-input>
        ${
          shown.length === 0
            ? empty(phMagnifyingGlass, "No repository matches.")
            : html`<gw-grid>
                ${shown.map(
                  ({ repo, title, activity }) =>
                    html`<gw-card
                      heading=${title}
                      description=${repo.repo}
                      href=${repoHref(repo.repo)}
                    >
                      <gw-row gap="s">
                        ${
                          activity.unread === 0
                            ? nothing
                            : html`<gw-chip size="xs" tone="accent"
                                >${plural(activity.unread, "unread change")}</gw-chip
                              >`
                        }
                        <gw-chip size="xs"
                          >${plural(repo.jobs.length, "job")}</gw-chip
                        >
                        ${
                          activity.lastAt === null
                            ? html`<span class="when">Nothing lately</span>`
                            : html`<span class="when"
                                >Changed ${time(activity.lastAt)}</span
                              >`
                        }
                      </gw-row>
                    </gw-card>`,
                )}
              </gw-grid>`
        }
      </gw-stack>
    `;
  }

  override render() {
    return view(this.#repos.value, (tracked) => this.#render(tracked));
  }
}

customElements.define("upkeep-repos", UpkeepRepos);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-repos": UpkeepRepos;
  }
}
