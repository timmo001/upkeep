/**
 * `upkeep-runs`: the latest runs, of every job or the one in `job`, grouped
 * by day and kept up to date while it's on screen. A run's whole row opens
 * it, with its log.
 */
import { mdiHistory } from "@mdi/js";
import type {
  TableColumn,
  TableRow,
} from "@timmo001/groundwork-ui/gw-table.ts";
import type { Domain } from "@upkeep/api";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement } from "lit";
import { always, AtomController } from "./AtomController.ts";
import {
  attentionBadge,
  duration,
  empty,
  externalLink,
  shared,
  stateBadge,
  time,
  view,
} from "./ui.ts";
import { type CellContent, cell } from "./upkeep-cell.ts";
import { jobHref, jobs, runHref, runs } from "./upkeep.ts";
import "@timmo001/groundwork-ui/gw-table.ts";

const release = (run: Domain.Run) =>
  run.release === null
    ? ""
    : externalLink(run.release.url, `${run.release.repo}@${run.release.tag}`);

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
  static override properties = { job: {} };

  static override styles = [
    shared,
    css`
      /* Each run's row opens it, through the link on its state */
      gw-table::part(row) {
        position: relative;
        cursor: pointer;
      }
    `,
  ];

  /** The job to show the runs of, or every job's when empty. */
  declare job: string;

  constructor() {
    super();
    this.job = "";
  }

  readonly #runs = new AtomController(this, () => runs(this.job), always);

  readonly #jobs = new AtomController(this, () => jobs, always);

  #laneOf(job: string) {
    const known = AsyncResult.isSuccess(this.#jobs.value)
      ? this.#jobs.value.value
      : [];

    return known.find((item) => item.id === job)?.lane ?? "repos";
  }

  /** The runs as a table, newest first, grouped by the day each was queued. */
  #table(list: ReadonlyArray<Domain.Run>) {
    const byId = new Map(list.map((run) => [run.id, run]));

    const draw =
      (content: (run: Domain.Run) => CellContent) => (row: TableRow) => {
        const run = byId.get(String(row.id));

        return cell(run === undefined ? "" : content(run));
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
        ),
      },
      ...(this.job === ""
        ? [
            {
              id: "job",
              header: "Job",
              cell: draw(
                (run: Domain.Run) =>
                  html`<a href=${jobHref(run.job)}>${run.job}</a>`,
              ),
            },
          ]
        : []),
      {
        id: "trigger",
        header: "Trigger",
        cell: draw(
          (run) =>
            html`${run.trigger}${
              run.heal === null
                ? ""
                : html` of <a href=${runHref(run.heal.of)}>${run.heal.job}</a>`
            }`,
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
        ),
      },
      {
        id: "release",
        header: "Release",
        cell: draw((run) => release(run)),
      },
      {
        id: "worker",
        header: "Worker",
        cell: draw((run) =>
          run.state === "queued"
            ? html`<span class="muted"
                >waiting in the ${this.#laneOf(run.job)} lane</span
              >`
            : (run.worker ?? ""),
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
        cell: draw((run) => time(run.queuedAt)),
      },
      {
        id: "took",
        header: "Took",
        sortable: false,
        searchable: false,
        cell: draw((run) => duration(run)),
      },
    ];

    return html`<gw-table
      label="Runs"
      group="day"
      row-key="id"
      search-label="Search runs"
      .columns=${columns}
      .rows=${list.map((run) => ({
        id: run.id,
        state: run.state,
        job: run.job,
        trigger:
          run.heal === null ? run.trigger : `${run.trigger} ${run.heal.job}`,
        summary: run.summary?.split("\n")[0] ?? "",
        release:
          run.release === null ? "" : `${run.release.repo}@${run.release.tag}`,
        worker: run.worker ?? "",
        day: dayOf(run.queuedAt),
        queued: run.queuedAt,
      }))}
    ></gw-table>`;
  }

  override render() {
    return view(this.#runs.value, (all) => {
      // Every job's runs leave out the ones that found nothing to do, which
      // a job's own page still lists
      const list =
        this.job === "" ? all.filter((run) => run.state !== "skipped") : all;

      return list.length === 0
        ? empty(mdiHistory, "No runs yet.")
        : this.#table(list);
    });
  }
}

customElements.define("upkeep-runs", UpkeepRuns);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-runs": UpkeepRuns;
  }
}
