/**
 * `upkeep-runs`: the latest runs, of every job or the one in `job`, grouped
 * by day and kept up to date while it's on screen. A run's whole row opens
 * it, with its log. Beside the table's search, a Filters button opens a
 * sheet of filters, as the inbox's does, each on shown as a chip that takes
 * it off. The filters are kept with the table's own view state, in
 * groundwork's shared store.
 */
import { GwFilter } from "@timmo001/groundwork-ui/gw-filter.ts";
import { GwSheet } from "@timmo001/groundwork-ui/gw-sheet.ts";
import type {
  TableColumn,
  TableRow,
} from "@timmo001/groundwork-ui/gw-table.ts";
import { keep, keptAt, textsOf } from "@timmo001/groundwork-ui/kept.ts";
import type { Domain } from "@upkeep/api";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement } from "lit";
import { ref } from "lit/directives/ref.js";
import { always, AtomController } from "./AtomController.ts";
import {
  phBookBookmark,
  phBriefcase,
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
import { jobHref, jobs, runHref, runs } from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/gw-filter.ts";
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

const sameValues = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((value) => b.includes(value));

/** The release a run is for, or the one repository it was narrowed to. */
const release = (run: Domain.Run) =>
  run.release !== null
    ? externalLink(run.release.url, `${run.release.repo}@${run.release.tag}`)
    : run.repo == null
      ? ""
      : externalLink(`https://github.com/${run.repo}`, run.repo);

/** The local day a time falls on, as `YYYY-MM-DD`, which groups runs. */
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

/** A day's heading: Today, Yesterday, or its date. */
const dayLabel = (day: string) => {
  if (day === dayOf(Date.now())) return "Today";

  if (day === dayOf(Date.now() - 24 * 60 * 60 * 1000)) return "Yesterday";

  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);

  return dayFormat.format(new Date(year, month - 1, date));
};

export class UpkeepRuns extends LitElement {
  static override properties = {
    job: {},
    groupsCollapsed: { type: Boolean, attribute: "groups-collapsed" },
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
    `,
  ];

  /** The job to show the runs of, or every job's when empty. */
  declare job: string;

  /** Starts with every day folded away. */
  declare groupsCollapsed: boolean;

  #sheet: GwSheet | undefined;

  constructor() {
    super();
    this.job = "";
    this.groupsCollapsed = false;
  }

  readonly #runs = new AtomController(this, () => runs(this.job), always);

  readonly #jobs = new AtomController(this, () => jobs, always);

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
      ? values.filter((value) => value !== "skipped")
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
    this.requestUpdate();
  }

  /** Takes a filter off, back to its default. */
  #off(filter: RunFilter) {
    keep(this.#storageKey, { [filter.id]: null });
    this.requestUpdate();
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

    return html`<gw-button
        slot="toolbar"
        appearance=${on.length > 0 ? "accent" : "outlined"}
        variant=${on.length > 0 ? "brand" : "neutral"}
        icon=${phFunnelSimple}
        @click=${() => this.#sheet?.toggle()}
        >${on.length > 0 ? `Filters (${on.length})` : "Filters"}</gw-button
      >
      ${on.map(({ filter, options, value }) => {
        const [only] = value;

        // The one value it's narrowed to by name, or how many
        const label =
          value.length === 1 && only !== undefined
            ? (options.find((option) => option.value === only)?.label ?? only)
            : `${value.length === 0 ? "All" : value.length} ${filter.many}`;

        return html`<gw-button
          slot="toolbar"
          size="xs"
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

  /** The runs as a table, newest first, grouped by the day each was queued. */
  #table(all: ReadonlyArray<Domain.Run>) {
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

    const list = all.filter((run) =>
      filters.every(({ filter, value }) => {
        const of = filter.of(run);

        return value.length === 0 || (of !== null && value.includes(of.value));
      }),
    );

    const byId = new Map(list.map((run) => [run.id, run]));

    // Every column has a fixed width but the summary, which takes the rest,
    // and every row one line, so the table keeps its shape whichever rows
    // are on screen and as runs move on
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
          { width: "7rem" },
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
                { width: "7.5rem" },
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
          { width: "5.5rem" },
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
        cell: draw((run) => release(run), { width: "6.5rem" }),
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
          { width: "6.5rem" },
        ),
      },
      {
        id: "day",
        header: "Day",
        groupLabel: (value) => dayLabel(String(value)),
      },
      {
        id: "queued",
        header: "Queued",
        searchable: false,
        cell: draw((run) => time(run.queuedAt), { width: "7rem" }),
      },
      {
        id: "took",
        header: "Took",
        sortable: false,
        searchable: false,
        cell: draw((run) => duration(run), { width: "3.5rem" }),
      },
    ];

    // The search always shows, so it doesn't come and go as the filters
    // narrow the rows
    return html`<gw-table
      storage-key=${this.#storageKey}
      label="Runs"
      group="day"
      ?groups-collapsed=${this.groupsCollapsed}
      contained
      row-key="id"
      search="always"
      search-label="Search runs"
      empty-label="No runs match the filters"
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
        day: dayOf(run.queuedAt),
        queued: run.queuedAt,
      }))}
    >
      ${this.#toolbar(filters)}
    </gw-table>`;
  }

  override render() {
    return view(this.#runs.value, (all) =>
      all.length === 0
        ? empty(phClockCounterClockwise, "No runs yet.")
        : this.#table(all),
    );
  }
}

customElements.define("upkeep-runs", UpkeepRuns);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-runs": UpkeepRuns;
  }
}
