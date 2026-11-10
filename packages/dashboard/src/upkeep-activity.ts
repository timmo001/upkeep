/**
 * `upkeep-activity`: the Activity page, what happened on GitHub over the last
 * 90 days as the timeline job found it. Activity on one issue or pull request
 * is gathered under it, newest first, as an expansion panel that starts open;
 * commits, pushes and releases stand on their own lines. It's a groundwork
 * `gw-list`, so only the groups on screen are drawn, and older groups load a
 * page at a time from its end. Nothing here is marked read. A Filters button
 * opens a sheet of filters, as the runs list's does, each on shown as a chip
 * that takes it off; they're kept in groundwork's shared store and sent to
 * the server, so paging only reads what's shown.
 */
import { GwFilter } from "@timmo001/groundwork-ui/gw-filter.ts";
import { GwSegmented } from "@timmo001/groundwork-ui/gw-segmented.ts";
import { GwSheet } from "@timmo001/groundwork-ui/gw-sheet.ts";
import { isText, keep, keptAt, textsOf } from "@timmo001/groundwork-ui/kept.ts";
import type { Domain } from "@upkeep/api";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement, nothing, render } from "lit";
import { ref } from "lit/directives/ref.js";
import { always, AtomController, registry } from "./AtomController.ts";
import {
  phBookBookmark,
  phChatCircle,
  phCheckCircle,
  phFunnelSimple,
  phGitCommit,
  phGitPullRequest,
  phPackage,
  phRecord,
  phRobot,
  phSquaresFour,
  phTag,
  phUser,
  phX,
} from "./icons.ts";
import { dayOf } from "./entries.ts";
import { empty, externalLink, icon, shared, time, view } from "./ui.ts";
import {
  olderTimeline,
  olderTimelineKey,
  repos,
  timeline,
  timelineFilterKey,
  timelinePage,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/gw-chip.ts";
import "@timmo001/groundwork-ui/define/gw-expansion.ts";
import "@timmo001/groundwork-ui/define/gw-filter.ts";
import "@timmo001/groundwork-ui/define/gw-list.ts";
import "@timmo001/groundwork-ui/define/gw-segmented.ts";
import "@timmo001/groundwork-ui/define/gw-sheet.ts";
import "@timmo001/groundwork-ui/define/layout.ts";

/** Where the filters are kept. */
const storageKey = "upkeep.activity";

const kindLabels: Record<Domain.TimelineKind, string> = {
  commit: "Commits",
  push: "Pushes",
  pull_request: "Pull requests",
  issue: "Issues",
  review: "Reviews",
  comment: "Comments",
  release: "Releases",
};

const kindIcons: Record<Domain.TimelineKind, string> = {
  commit: phGitCommit,
  push: phGitCommit,
  pull_request: phGitPullRequest,
  issue: phRecord,
  review: phCheckCircle,
  comment: phChatCircle,
  release: phTag,
};

const kindOptions = Object.entries(kindLabels).map(([value, label]) => ({
  value,
  label,
}));

const whoOptions = [
  { value: "", label: "Anyone", icon: phSquaresFour },
  { value: "you", label: "You", icon: phUser },
  { value: "bots", label: "Bots", icon: phRobot },
  { value: "others", label: "Others", icon: phPackage },
];

const isWho = (value: string): value is Domain.TimelineWho =>
  value === "you" || value === "bots" || value === "others";

const stateTones: Record<Domain.TimelineSubject["state"], string> = {
  open: "success",
  closed: "danger",
  merged: "accent",
};

const keyOf = (group: Domain.TimelineGroup) => group.key;

/** The day a group's latest activity was on, as the start of that day. */
const dayKey = (group: Domain.TimelineGroup) =>
  String(new Date(group.lastAt).setHours(0, 0, 0, 0));

const dayLabel = (value: string) => dayOf(Number(value));

/** One thing that happened, as a line: who did what, its title and when. */
const line = (item: Domain.TimelineItem, withRepo: boolean) =>
  html`<li>
    ${icon(kindIcons[item.kind])}
    <span class="what"
      ><strong>${item.actor ?? "Someone"}</strong> ${item.action}${
        withRepo ? html` in ${item.repo}` : nothing
      }${
        item.title === ""
          ? html` ${externalLink(item.url, "on GitHub")}`
          : html`: ${externalLink(item.url, item.title)}`
      }</span
    >
    <span class="when">${time(item.at)}</span>
  </li>`;

export class UpkeepActivity extends LitElement {
  static override styles = [
    shared,
    css`
      gw-sheet {
        --gw-filter-inset: var(--gw-space-4);
      }

      .who {
        display: grid;
        gap: var(--gw-space-2);
        padding-inline: var(--gw-filter-inset);
      }

      ul {
        display: grid;
        gap: var(--gw-space-2);
        margin: 0;
        padding: 0;
        list-style: none;
      }

      li {
        display: flex;
        gap: var(--gw-space-2);
        align-items: baseline;
      }

      li .icon {
        flex: none;
        align-self: center;
      }

      .what {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .when,
      .more {
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }

      .when {
        flex: none;
      }

      .single {
        padding: var(--gw-space-3) var(--gw-space-4);
        border: 1px solid var(--gw-color-border);
        border-radius: var(--gw-radius-m);
      }

      .end {
        display: flex;
        justify-content: center;
        padding-block: var(--gw-space-4);
      }
    `,
  ];

  #sheet: GwSheet | undefined;

  /** The kinds, repositories and who the page is narrowed to, empty for any. */
  get #filters() {
    const kept = keptAt(storageKey);
    const who = kept?.["who"];

    return {
      kinds: textsOf(kept?.["kinds"]) ?? [],
      repos: textsOf(kept?.["repos"]) ?? [],
      who: isText(who) && isWho(who) ? who : "",
    };
  }

  get #key() {
    const { kinds, repos, who } = this.#filters;

    return timelineFilterKey(kinds, repos, who);
  }

  readonly #latest = new AtomController(
    this,
    () => timeline(this.#key),
    always,
  );

  readonly #repos = new AtomController(this, () => repos);

  /** The cursors each older page was loaded after, oldest page last. */
  #cursors: string[] = [];

  /** Each older page's subscription, which keeps it loaded. */
  #pages: Array<() => void> = [];

  /** The filters the older pages were loaded for. */
  #pagedFor = "";

  #resetPages() {
    for (const unsubscribe of this.#pages) unsubscribe();

    this.#pages = [];
    this.#cursors = [];
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#resetPages();
  }

  #page(before: string) {
    return registry.get(olderTimeline(olderTimelineKey(before, this.#key)));
  }

  /**
   * The latest groups with the older pages under them, each group once,
   * where its latest activity puts it.
   */
  #merged(latest: Domain.Timeline) {
    const seen = new Set<string>();

    const pages = this.#cursors.flatMap((before) => {
      const page = this.#page(before);

      return AsyncResult.isSuccess(page) ? page.value.groups : [];
    });

    return [...latest.groups, ...pages]
      .filter((group) => {
        if (seen.has(group.key)) return false;

        seen.add(group.key);

        return true;
      })
      .toSorted((a, b) => b.lastAt - a.lastAt);
  }

  /** The cursor of the next page to load, or null when there's none. */
  #next(latest: Domain.Timeline) {
    const last = this.#cursors.at(-1);

    if (last === undefined) return latest.next;

    const page = this.#page(last);

    return AsyncResult.isSuccess(page) ? page.value.next : null;
  }

  /** Whether the last older page is still loading. */
  #loading() {
    const last = this.#cursors.at(-1);

    return (
      last !== undefined &&
      !AsyncResult.isSuccess(this.#page(last)) &&
      !AsyncResult.isFailure(this.#page(last))
    );
  }

  #loadOlder(next: string) {
    if (this.#cursors.includes(next)) return;

    this.#cursors = [...this.#cursors, next];
    this.#pages.push(
      registry.subscribe(olderTimeline(olderTimelineKey(next, this.#key)), () =>
        this.requestUpdate(),
      ),
    );
    this.requestUpdate();
  }

  /** Keeps a filter's value, or forgets it when it's back to any. */
  #choose(
    id: "kinds" | "repos" | "who",
    value: ReadonlyArray<string> | string,
  ) {
    keep(storageKey, {
      [id]: value.length === 0 ? null : value,
    });

    this.#resetPages();
    this.requestUpdate();
  }

  /** The repositories to filter by: the tracked ones and any others shown. */
  #repoOptions(groups: ReadonlyArray<Domain.TimelineGroup>) {
    const tracked = AsyncResult.isSuccess(this.#repos.value)
      ? this.#repos.value.value.map((repo) => repo.repo)
      : [];

    const all = new Map(
      [
        ...tracked,
        ...groups.flatMap((group) => group.items.map((item) => item.repo)),
        ...this.#filters.repos,
      ].map((repo) => [repo.toLowerCase(), repo]),
    );

    return [...all.values()]
      .toSorted((a, b) => a.localeCompare(b))
      .map((repo) => ({ value: repo, label: repo }));
  }

  /**
   * The Filters button, counting the filters that are on, a chip for each
   * that takes it off, and the sheet it opens.
   */
  #toolbar(groups: ReadonlyArray<Domain.TimelineGroup>) {
    const { kinds, repos, who } = this.#filters;

    const chips = [
      ...(kinds.length === 0
        ? []
        : [
            {
              id: "kinds" as const,
              label:
                kinds.length === 1
                  ? (kindOptions.find((option) => option.value === kinds[0])
                      ?.label ?? kinds.join(""))
                  : `${kinds.length} kinds`,
            },
          ]),
      ...(repos.length === 0
        ? []
        : [
            {
              id: "repos" as const,
              label:
                repos.length === 1
                  ? repos.join("")
                  : `${repos.length} repositories`,
            },
          ]),
      ...(who === ""
        ? []
        : [
            {
              id: "who" as const,
              label:
                whoOptions.find((option) => option.value === who)?.label ?? who,
            },
          ]),
    ];

    return html`<gw-button
        slot="actions"
        size="small"
        appearance=${chips.length > 0 ? "accent" : "outlined"}
        variant=${chips.length > 0 ? "brand" : "neutral"}
        icon=${phFunnelSimple}
        @click=${() => this.#sheet?.toggle()}
        >${chips.length > 0 ? `Filters (${chips.length})` : "Filters"}</gw-button
      >
      ${chips.map(
        (chip) =>
          html`<gw-button
            slot="actions"
            size="small"
            appearance="outlined"
            variant="neutral"
            icon=${phX}
            label=${`Remove ${chip.label}`}
            @click=${() => this.#choose(chip.id, [])}
            >${chip.label}</gw-button
          >`,
      )}
      <gw-sheet
        slot="actions"
        heading="Filters"
        ${ref((element) => {
          this.#sheet = element instanceof GwSheet ? element : undefined;
        })}
      >
        <div class="who">
          <gw-segmented
            size="small"
            label="Who"
            value=${who}
            .options=${whoOptions}
            @change=${(event: Event) =>
              this.#choose(
                "who",
                event.currentTarget instanceof GwSegmented
                  ? event.currentTarget.value
                  : "",
              )}
          ></gw-segmented>
        </div>
        <gw-filter
          label="Kind"
          icon=${phSquaresFour}
          search-label="Search kinds"
          .options=${kindOptions}
          .value=${kinds}
          .defaultValue=${[]}
          @change=${(event: Event) =>
            this.#choose(
              "kinds",
              event.currentTarget instanceof GwFilter
                ? event.currentTarget.value
                : [],
            )}
        ></gw-filter>
        <gw-filter
          label="Repository"
          icon=${phBookBookmark}
          search-label="Search repositories"
          .options=${this.#repoOptions(groups)}
          .value=${repos}
          .defaultValue=${[]}
          @change=${(event: Event) =>
            this.#choose(
              "repos",
              event.currentTarget instanceof GwFilter
                ? event.currentTarget.value
                : [],
            )}
        ></gw-filter>
      </gw-sheet>`;
  }

  /** An issue or pull request with its latest activity, or one item alone. */
  #group(group: Domain.TimelineGroup) {
    const { subject } = group;
    const [first] = group.items;

    if (subject === null || first === undefined) {
      return first === undefined
        ? nothing
        : html`<ul class="single">
            ${line(first, true)}
          </ul>`;
    }

    return html`<gw-expansion
      open
      heading=${subject.title}
      description=${`${first.repo}#${subject.number}${subject.author === null ? "" : ` by ${subject.author}`}`}
    >
      <span slot="icon">${icon(kindIcons[subject.kind])}</span>
      <gw-chip slot="actions" size="xs" tone=${stateTones[subject.state]}
        >${subject.state}</gw-chip
      >
      <span slot="actions" class="when">${time(group.lastAt)}</span>
      <gw-stack gap="s">
        <ul>
          ${group.items.map((item) => line(item, false))}
        </ul>
        <span class="more"
          >${
            group.more > 0
              ? html`${group.more} older on
                ${externalLink(subject.url, `${first.repo}#${subject.number}`)}`
              : externalLink(subject.url, `${first.repo}#${subject.number}`)
          }</span
        >
      </gw-stack>
    </gw-expansion>`;
  }

  #draw = (group: Domain.TimelineGroup, target: HTMLElement) => {
    render(this.#group(group), target);
  };

  #render(latest: Domain.Timeline) {
    // Pages loaded for other filters hold the wrong groups
    if (this.#pagedFor !== this.#key) {
      this.#resetPages();
      this.#pagedFor = this.#key;
    }

    const groups = this.#merged(latest);
    const next = this.#next(latest);
    const filtered = this.#filters;

    const narrowed =
      filtered.kinds.length > 0 ||
      filtered.repos.length > 0 ||
      filtered.who !== "";

    return html`<gw-stack gap="l">
      <gw-page-header
        heading="Activity"
        description="What happened on GitHub over the last 90 days"
      >
        ${this.#toolbar(groups)}
      </gw-page-header>
      ${
        groups.length === 0
          ? empty(
              phChatCircle,
              narrowed
                ? "Nothing matches the filters."
                : "Nothing yet. The Activity job fills this every 15 minutes.",
            )
          : html`<gw-list
              label="Activity"
              estimate="120"
              .items=${groups}
              .keyOf=${keyOf}
              .groupOf=${dayKey}
              .groupLabel=${dayLabel}
              .draw=${this.#draw}
            ></gw-list>`
      }
      ${
        next === null
          ? nothing
          : html`<div class="end">
              <gw-button
                appearance="outlined"
                variant="neutral"
                ?loading=${this.#loading()}
                ${ref((element) => this.#watchEnd(element, next))}
                @click=${() => this.#loadOlder(next)}
                >Show older (${timelinePage} more)</gw-button
              >
            </div>`
      }
    </gw-stack>`;
  }

  #observer: IntersectionObserver | undefined;

  /** Loads the next page once the button at the end scrolls into view. */
  #watchEnd(element: Element | undefined, next: string) {
    this.#observer?.disconnect();

    if (element === undefined) return;

    this.#observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) this.#loadOlder(next);
    });
    this.#observer.observe(element);
  }

  override render() {
    return view(this.#latest.value, (latest) => this.#render(latest));
  }
}

customElements.define("upkeep-activity", UpkeepActivity);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-activity": UpkeepActivity;
  }
}
