/**
 * `upkeep-runs`: the latest runs, of every job or the one in `job`, as one
 * list, newest first, kept up to date while it's on screen. A run's whole row
 * opens it, with its log. Beside the table's search, a Filters button opens a
 * sheet of filters, as the inbox's does, each on shown as a chip that takes
 * it off. A date there narrows the list to one day's runs, which the server
 * picks, so any day can be looked at without scrolling back to it. The
 * filters are kept with the table's own view state, in groundwork's shared
 * store. Older runs load a page at a time as the table scrolls to its end.
 */
import { GwFilter } from "@timmo001/groundwork-ui/gw-filter.ts";
import { GwSheet } from "@timmo001/groundwork-ui/gw-sheet.ts";
import type {
  TableColumn,
  TableRow,
} from "@timmo001/groundwork-ui/gw-table.ts";
import { GwInput } from "@timmo001/groundwork-ui/gw-input.ts";
import { isText, keep, keptAt, textsOf } from "@timmo001/groundwork-ui/kept.ts";
import { Domain } from "@upkeep/api";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement } from "lit";
import { ref } from "lit/directives/ref.js";
import { always, AtomController, registry } from "./AtomController.ts";
import {
  phBookBookmark,
  phBriefcase,
  phCalendarBlank,
  phCheckCircle,
  phClockCounterClockwise,
  phFunnelSimple,
  phPlay,
  phTerminalWindow,
  phX,
} from "./icons.ts";
import {
  attentionBadge,
  capitalise,
  duration,
  empty,
  externalLink,
  jobName,
  shared,
  stateBadge,
  stateLabel,
  time,
  view,
} from "./ui.ts";
import { type CellContent, type CellSize, cell } from "./upkeep-cell.ts";
import {
  jobHref,
  jobs,
  olderRuns,
  olderRunsKey,
  runHref,
  runs,
  runsOn,
  runsOnKey,
  runsPage,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/gw-filter.ts";
import "@timmo001/groundwork-ui/define/gw-input.ts";
import "@timmo001/groundwork-ui/define/gw-sheet.ts";
import "@timmo001/groundwork-ui/define/gw-table.ts";

/** Each filter of the runs, by the key it's kept under. */
type FilterId = "states" | "jobs" | "triggers" | "repos" | "workers";

interface RunFilter {
  readonly id: FilterId;
  readonly label: string;
  /** Its values in the plural, for its search field. */
  readonly many: string;
  readonly icon: string;
  /** A run's value for the filter, with its name, or null when it has none. */
  readonly of: (
    run: Domain.Run,
  ) => { readonly value: string; readonly label: string } | null;
}

const runFilters: ReadonlyArray<RunFilter> = [
  {
    id: "states",
    label: "State",
    many: "states",
    icon: phCheckCircle,
    of: (run) => ({ value: run.state, label: stateLabel(run.state) }),
  },
  {
    id: "jobs",
    label: "Job",
    many: "jobs",
    icon: phBriefcase,
    of: (run) => ({ value: run.job, label: jobName(run.job) }),
  },
  {
    id: "triggers",
    label: "Trigger",
    many: "triggers",
    icon: phPlay,
    of: (run) => ({ value: run.trigger, label: capitalise(run.trigger) }),
  },
  {
    id: "repos",
    label: "Repository",
    many: "repositories",
    icon: phBookBookmark,
    of: (run) => {
      const repo = run.release?.repo ?? run.repo ?? null;

      return repo === null ? null : { value: repo, label: repo };
    },
  },
  {
    id: "workers",
    label: "Worker",
    many: "workers",
    icon: phTerminalWindow,
    of: (run) =>
      run.worker === null ? null : { value: run.worker, label: run.worker },
  },
];

/** A filter's options: each value the runs have, with how many have it. */
const optionsOf = (filter: RunFilter, list: ReadonlyArray<Domain.Run>) => {
  const counts = new Map<string, { label: string; count: number }>();

  for (const run of list) {
    const value = filter.of(run);

    if (value === null) continue;

    const seen = counts.get(value.value);

    counts.set(value.value, {
      label: value.label,
      count: (seen?.count ?? 0) + 1,
    });
  }

  return [...counts]
    .map(([value, { label, count }]) => ({ value, label, count }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
};

/** The state every job's runs leave out until someone changes the filter. */
const leftOut: Domain.RunState = "skipped";

const sameValues = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((value) => b.includes(value));

/** The release a run is for, or the one repository it was narrowed to. */
const release = (run: Domain.Run) =>
  run.release !== null
    ? externalLink(run.release.url, `${run.release.repo}@${run.release.tag}`)
    : run.repo == null
      ? ""
      : externalLink(`https://github.com/${run.repo}`, run.repo);

/** The local day a time falls on, as `YYYY-MM-DD`, as the date filter keeps it. */
const dayOf = (millis: number) => {
  const date = new Date(millis);

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
};

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
});

/** Today's and yesterday's dates, which the date filter offers by name. */
const today = () => dayOf(Date.now());

const yesterday = () => {
  const date = new Date();

  return dayOf(date.setDate(date.getDate() - 1));
};

/** A day's name in the date filter's chip: Today, Yesterday, or its date. */
const dayLabel = (day: string) => {
  if (day === today()) return "Today";

  if (day === yesterday()) return "Yesterday";

  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);

  return dayFormat.format(new Date(year, month - 1, date));
};

/** Whether text is a date the filter can use, `YYYY-MM-DD`. */
const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

export class UpkeepRuns extends LitElement {
  static override properties = {
    job: {},
  };

  static override styles = [
    shared,
    css`
      /* Each run's row opens it, through the link on its state */
      gw-table::part(row) {
        position: relative;
        cursor: pointer;
      }

      gw-sheet {
        --gw-filter-inset: var(--gw-space-4);
      }

      .date {
        display: grid;
        gap: var(--gw-space-2);
        padding-inline: var(--gw-filter-inset);
      }

      .date .quick {
        display: flex;
        gap: var(--gw-space-2);
      }
    `,
  ];

  /** The job to show the runs of, or every job's when empty. */
  declare job: string;

  #sheet: GwSheet | undefined;

  constructor() {
    super();
    this.job = "";
  }

  /** The day the list is narrowed to, `YYYY-MM-DD`, or every day when empty. */
  get #day() {
    const kept = keptAt(this.#storageKey)?.["day"];

    return isText(kept) && isDay(kept) ? kept : "";
  }

  // One day's runs come from the server, so a day long past shows without
  // paging back to it
  readonly #runs = new AtomController(
    this,
    () =>
      this.#day === ""
        ? runs(this.job)
        : runsOn(runsOnKey(this.job, this.#day)),
    always,
  );

  readonly #jobs = new AtomController(this, () => jobs, always);

  /** The runs each older page was loaded before, oldest page last. */
  #cursors: string[] = [];

  /** The states the older pages keep, all of them when empty. */
  #states: ReadonlyArray<string> = [];

  /** Each older page's subscription, which keeps it loaded. */
  #pages: Array<() => void> = [];

  /**
   * Every run shown once older pages are loaded, by id, so a run the latest
   * page drops as new runs arrive stays rather than leaving a gap above the
   * older pages.
   */
  #kept = new Map<string, Domain.Run>();

  /** Forgets the older pages, for another job's runs or when it's gone. */
  #resetPages() {
    for (const unsubscribe of this.#pages) unsubscribe();

    this.#pages = [];
    this.#cursors = [];
    this.#states = [];
    this.#kept = new Map();
  }

  /** An older page's runs, as loaded so far. */
  #page(before: string) {
    return registry.get(
      olderRuns(olderRunsKey(this.job, before, this.#states, this.#day)),
    );
  }

  override willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has("job")) this.#resetPages();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#resetPages();
  }

  /** The older pages' runs loaded so far, oldest page last. */
  #older() {
    return this.#cursors.flatMap((before) => {
      const page = this.#page(before);

      return AsyncResult.isSuccess(page) ? page.value : [];
    });
  }

  /**
   * The latest runs with the older pages under them, newest first, as the
   * server orders them.
   */
  #merged(latest: ReadonlyArray<Domain.Run>) {
    if (this.#cursors.length === 0) return latest;

    for (const run of [...this.#older(), ...latest]) {
      this.#kept.set(run.id, run);
    }

    return [...this.#kept.values()].toSorted(
      (a, b) =>
        b.queuedAt - a.queuedAt || Number(a.id < b.id) - Number(a.id > b.id),
    );
  }

  /**
   * Whether there may be older runs to load: the last page came back full,
   * or is still loading. A page that failed stops the loading.
   */
  #hasMore(latest: ReadonlyArray<Domain.Run>) {
    const last = this.#cursors.at(-1);

    if (last === undefined) return latest.length >= runsPage;

    const page = this.#page(last);

    if (AsyncResult.isSuccess(page)) return page.value.length >= runsPage;

    return !AsyncResult.isFailure(page);
  }

  /**
   * Loads the page of runs before the oldest shown, once, in only the
   * `states` the table shows, so a filter that hides most runs doesn't page
   * through all of them to fill the view.
   */
  #loadOlder(all: ReadonlyArray<Domain.Run>, states: ReadonlyArray<string>) {
    // Pages loaded for other states hold the wrong runs, so they start again
    if (!sameValues(states, this.#states)) {
      this.#resetPages();
      this.#states = states;
    }

    const oldest = all.at(-1);

    if (oldest === undefined || this.#cursors.includes(oldest.id)) return;

    this.#cursors = [...this.#cursors, oldest.id];
    this.#pages.push(
      registry.subscribe(
        olderRuns(olderRunsKey(this.job, oldest.id, states, this.#day)),
        () => this.requestUpdate(),
      ),
    );
    this.requestUpdate();
  }

  /**
   * The states the server keeps for older pages: the ones chosen, every one
   * but those the default leaves out, or all of them (empty).
   */
  #serverStates(chosen: ReadonlyArray<string> | undefined) {
    if (chosen !== undefined) return chosen;

    return this.job === ""
      ? Domain.RunState.literals.filter((state) => state !== leftOut)
      : [];
  }

  #laneOf(job: string) {
    const known = AsyncResult.isSuccess(this.#jobs.value)
      ? this.#jobs.value.value
      : [];

    return known.find((item) => item.id === job)?.lane ?? "repos";
  }

  /** Where the table keeps its view state, and the filters beside it. */
  get #storageKey() {
    return this.job === "" ? "upkeep.runs.table" : "upkeep.job-runs.table";
  }

  /**
   * What a filter shows until someone changes it: everything, but every
   * job's runs leave out the ones that found nothing to do, which a job's own
   * page still lists.
   */
  #defaultOf(filter: RunFilter, values: ReadonlyArray<string>) {
    return filter.id === "states" && this.job === ""
      ? values.filter((value) => value !== leftOut)
      : [];
  }

  /** Keeps a filter's new value, or forgets it when it's back to its default. */
  #choose(
    filter: RunFilter,
    value: ReadonlyArray<string>,
    fallback: ReadonlyArray<string>,
  ) {
    keep(this.#storageKey, {
      [filter.id]: sameValues(value, fallback) ? null : value,
    });

    // Older pages were loaded for the states shown before
    if (filter.id === "states") this.#resetPages();

    this.requestUpdate();
  }

  /** Takes a filter off, back to its default. */
  #off(filter: RunFilter) {
    keep(this.#storageKey, { [filter.id]: null });

    if (filter.id === "states") this.#resetPages();

    this.requestUpdate();
  }

  /** Narrows the list to one day's runs, or every day's with none. */
  #setDay(day: string) {
    keep(this.#storageKey, { day: isDay(day) ? day : null });

    // Older pages were loaded for the day shown before
    this.#resetPages();
    this.requestUpdate();
  }

  /** The date filter: a date to pick, with today and yesterday a click away. */
  #dateFilter() {
    const day = this.#day;

    const quick = (label: string, value: string) =>
      html`<gw-button
        size="small"
        appearance=${day === value ? "accent" : "outlined"}
        variant=${day === value ? "brand" : "neutral"}
        @click=${() => this.#setDay(day === value ? "" : value)}
        >${label}</gw-button
      >`;

    return html`<div class="date">
      <gw-input
        type="date"
        label="Date"
        icon=${phCalendarBlank}
        max=${today()}
        .value=${day}
        @input=${(event: Event) =>
          this.#setDay(
            event.currentTarget instanceof GwInput
              ? event.currentTarget.value
              : "",
          )}
      ></gw-input>
      <div class="quick">
        ${quick("Today", today())} ${quick("Yesterday", yesterday())}
      </div>
    </div>`;
  }

  /**
   * The Filters button beside the table's search, counting the filters that
   * are on, with a chip for each that takes it off, and the sheet it opens,
   * as the inbox's filters work.
   */
  #toolbar(
    filters: ReadonlyArray<{
      readonly filter: RunFilter;
      readonly options: ReadonlyArray<{
        readonly value: string;
        readonly label: string;
        readonly count: number;
      }>;
      readonly value: ReadonlyArray<string>;
      readonly fallback: ReadonlyArray<string>;
      readonly on: boolean;
      readonly shown: boolean;
    }>,
  ) {
    const on = filters.filter((each) => each.on);
    const day = this.#day;
    const count = on.length + (day === "" ? 0 : 1);

    // The button and its chips share one size, so neither dwarfs the other
    return html`<gw-button
        slot="toolbar"
        size="small"
        appearance=${count > 0 ? "accent" : "outlined"}
        variant=${count > 0 ? "brand" : "neutral"}
        icon=${phFunnelSimple}
        @click=${() => this.#sheet?.toggle()}
        >${count > 0 ? `Filters (${count})` : "Filters"}</gw-button
      >
      ${
        day === ""
          ? null
          : html`<gw-button
              slot="toolbar"
              size="small"
              appearance="outlined"
              variant="neutral"
              icon=${phX}
              label=${`Remove ${dayLabel(day)}`}
              @click=${() => this.#setDay("")}
              >${dayLabel(day)}</gw-button
            >`
      }
      ${on.map(({ filter, options, value }) => {
        const [only] = value;

        // The one value it's narrowed to by name, or how many
        const label =
          value.length === 1 && only !== undefined
            ? (options.find((option) => option.value === only)?.label ?? only)
            : `${value.length === 0 ? "All" : value.length} ${filter.many}`;

        return html`<gw-button
          slot="toolbar"
          size="small"
          appearance="outlined"
          variant="neutral"
          icon=${phX}
          label=${`Remove ${label}`}
          @click=${() => this.#off(filter)}
          >${label}</gw-button
        >`;
      })}
      <gw-sheet
        slot="toolbar"
        heading="Filters"
        ${ref((element) => {
          this.#sheet = element instanceof GwSheet ? element : undefined;
        })}
      >
        ${this.#dateFilter()}
        ${filters.flatMap(({ filter, options, value, fallback, shown }) =>
          shown
            ? [
                html`<gw-filter
                  label=${filter.label}
                  icon=${filter.icon}
                  search-label=${`Search ${filter.many}`}
                  .options=${options}
                  .value=${value}
                  .defaultValue=${fallback}
                  @change=${(event: Event) =>
                    this.#choose(
                      filter,
                      event.currentTarget instanceof GwFilter
                        ? event.currentTarget.value
                        : [],
                      fallback,
                    )}
                ></gw-filter>`,
              ]
            : [],
        )}
      </gw-sheet>`;
  }

  /**
   * The runs as a table, newest first, with skeleton rows and the next page
   * loading at its end while `more`.
   */
  #table(all: ReadonlyArray<Domain.Run>, more: boolean) {
    const kept = keptAt(this.#storageKey);

    const filters = runFilters.map((filter) => {
      const options = optionsOf(filter, all);

      const fallback = this.#defaultOf(
        filter,
        options.map((option) => option.value),
      );

      const chosen = textsOf(kept?.[filter.id]);

      return {
        filter,
        options,
        value: chosen ?? fallback,
        fallback,
        on: chosen !== undefined,
        // A filter with one value has nothing to narrow, unless it's on
        shown: options.length > 1 || chosen !== undefined,
      };
    });

    // Older pages come from the server in only the states shown
    const states = this.#serverStates(textsOf(kept?.["states"]));

    const list = all.filter((run) =>
      filters.every(({ filter, value }) => {
        const of = filter.of(run);

        return value.length === 0 || (of !== null && value.includes(of.value));
      }),
    );

    const byId = new Map(list.map((run) => [run.id, run]));

    // Every column fits its content, holding the widest it has been, but the
    // summary, which takes the rest, and every row is one line, so the table
    // keeps its shape whichever rows are on screen and as runs move on
    const draw =
      (content: (run: Domain.Run) => CellContent, size: CellSize) =>
      (row: TableRow) => {
        const run = byId.get(String(row.id));

        return cell(run === undefined ? "" : content(run), size);
      };

    const columns: TableColumn[] = [
      {
        id: "state",
        header: "State",
        cell: draw(
          (run) =>
            html`<a
              class="row-link"
              href=${runHref(run.id)}
              title="Open the run and its log"
              >${stateBadge(run.state)}</a
            >`,
          "fit",
        ),
      },
      ...(this.job === ""
        ? [
            {
              id: "job",
              header: "Job",
              cell: draw(
                (run: Domain.Run) =>
                  html`<a href=${jobHref(run.job)}>${jobName(run.job)}</a>`,
                "fit",
              ),
            },
          ]
        : []),
      {
        id: "trigger",
        header: "Trigger",
        cell: draw(
          (run) =>
            html`${capitalise(run.trigger)}${
              run.heal === null
                ? ""
                : html` of
                    <a href=${runHref(run.heal.of)}
                      >${jobName(run.heal.job)}</a
                    >`
            }`,
          "fit",
        ),
      },
      {
        id: "summary",
        header: "What it did",
        wide: true,
        cell: draw(
          (run) =>
            html`${run.attention ? attentionBadge : null}
            ${run.summary?.split("\n")[0] ?? ""}`,
          "fill",
        ),
      },
      {
        id: "release",
        header: "For",
        cell: draw((run) => release(run), "fit"),
      },
      {
        id: "worker",
        header: "Worker",
        cell: draw(
          (run) =>
            run.state === "queued"
              ? html`<span class="muted"
                  >waiting in the ${this.#laneOf(run.job)} lane</span
                >`
              : (run.worker ?? ""),
          "fit",
        ),
      },
      {
        id: "queued",
        header: "Queued",
        searchable: false,
        cell: draw((run) => time(run.queuedAt), "fit"),
      },
      {
        id: "took",
        header: "Took",
        sortable: false,
        searchable: false,
        cell: draw((run) => duration(run), "fit"),
      },
    ];

    // The search always shows, so it doesn't come and go as the filters
    // narrow the rows
    return html`<gw-table
      storage-key=${this.#storageKey}
      label="Runs"
      contained
      row-key="id"
      search="always"
      search-label="Search runs"
      empty-label="No runs match the filters"
      .more=${more}
      @more=${() => this.#loadOlder(all, states)}
      .columns=${columns}
      .rows=${list.map((run) => ({
        id: run.id,
        state: run.state,
        job: jobName(run.job),
        trigger:
          run.heal === null
            ? run.trigger
            : `${run.trigger} ${jobName(run.heal.job)}`,
        summary: run.summary?.split("\n")[0] ?? "",
        release:
          run.release === null
            ? (run.repo ?? "")
            : `${run.release.repo}@${run.release.tag}`,
        worker: run.worker ?? "",
        queued: run.queuedAt,
      }))}
    >
      ${this.#toolbar(filters)}
    </gw-table>`;
  }

  override render() {
    return view(this.#runs.value, (latest) => {
      const all = this.#merged(latest);

      // A day with no runs keeps the table, so its filter can be changed
      return all.length === 0 && this.#day === ""
        ? empty(phClockCounterClockwise, "No runs yet.")
        : this.#table(all, this.#hasMore(latest));
    });
  }
}

customElements.define("upkeep-runs", UpkeepRuns);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-runs": UpkeepRuns;
  }
}
