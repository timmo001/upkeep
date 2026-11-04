/**
 * `upkeep-overview`: the Jobs page. Every job, grouped by the lane it runs
 * in, with its latest run, a button to run it and, for a parked job, why and
 * a button to unpark it, and a switch to pause or resume it; then the latest
 * runs.
 */
import { mdiPause, mdiPlay, mdiPlayPause } from "@mdi/js";
import type {
  TableColumn,
  TableRow,
} from "@timmo001/groundwork-ui/gw-table.ts";
import type { Domain } from "@upkeep/api";
import cronstrue from "cronstrue";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement } from "lit";
import { always, AtomController, registry } from "./AtomController.ts";
import { shared, stateBadge, time, view } from "./ui.ts";
import { type CellContent, cell } from "./upkeep-cell.ts";
import {
  jobHref,
  jobs,
  pauseJob,
  resumeJob,
  runHref,
  runJob,
  unparkJob,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/gw-button.ts";
import "@timmo001/groundwork-ui/gw-page-header.ts";
import "@timmo001/groundwork-ui/gw-section-title.ts";
import "@timmo001/groundwork-ui/gw-table.ts";
import "./upkeep-runs.ts";

/** Each lane's heading: a lane runs one run at a time, so a job waits only behind its own lane. */
const laneLabels = new Map<string, string>([
  ["quick", "Quick lane: short jobs"],
  ["repos", "Repositories lane: jobs that change repositories"],
  ["heal", "Heal lane: fixes for failed runs"],
]);

/** What starts a job besides its run button, with a schedule in words. */
const starts = (job: Domain.JobStatus) =>
  [
    job.schedule === null
      ? null
      : html`<span title=${job.schedule}
          >${cronstrue.toString(job.schedule, {
            use24HourTimeFormat: true,
          })}</span
        >`,
    job.onRelease ? "On release" : null,
  ].filter((start) => start !== null);

export const jobActions = (job: Domain.JobStatus) => html`
  <gw-button
    size="small"
    appearance="filled"
    icon=${mdiPlay}
    @click=${() => registry.set(runJob, job.id)}
    >Run</gw-button
  >
  ${
    job.parked === null
      ? null
      : html`<gw-button
          size="small"
          appearance="outlined"
          variant="warning"
          icon=${mdiPlayPause}
          @click=${() => registry.set(unparkJob, job.id)}
          >Unpark</gw-button
        >`
  }
  ${
    job.paused === null
      ? html`<gw-button
          size="small"
          appearance="outlined"
          variant="neutral"
          icon=${mdiPause}
          title="Stop queueing it until it's resumed"
          @click=${() => registry.set(pauseJob, job.id)}
          >Pause</gw-button
        >`
      : html`<gw-button
          size="small"
          appearance="outlined"
          variant="warning"
          icon=${mdiPlay}
          @click=${() => registry.set(resumeJob, job.id)}
          >Resume</gw-button
        >`
  }
`;

export class UpkeepOverview extends LitElement {
  static override styles = [
    shared,
    css`
      upkeep-runs {
        margin-top: var(--gw-space-3);
      }

      .runs {
        display: block;
        margin-top: var(--gw-space-6);
      }

      gw-page-header {
        margin-bottom: var(--gw-space-4);
      }
    `,
  ];

  readonly #jobs = new AtomController(this, () => jobs, always);

  /** The jobs as a table, grouped by the lane each runs in. */
  #table(list: ReadonlyArray<Domain.JobStatus>) {
    const byId = new Map(list.map((job) => [job.id, job]));

    const draw =
      (content: (job: Domain.JobStatus) => CellContent) => (row: TableRow) => {
        const job = byId.get(String(row.id));

        return cell(job === undefined ? "" : content(job));
      };

    const columns: TableColumn[] = [
      {
        id: "name",
        header: "Job",
        wide: true,
        value: (row) => `${row.name} ${row.description}`,
        cell: draw(
          (job) =>
            html`<a href=${jobHref(job.id)}>${job.name}</a>
              <div class="muted">${job.description}</div>
              ${
                job.parked === null
                  ? null
                  : html`<div class="parked">
                      Parked ${time(job.parked.at)}: ${job.parked.reason}
                    </div>`
              }
              ${
                job.paused === null
                  ? null
                  : html`<div class="muted">
                      Paused ${time(job.paused.at)} by ${job.paused.by}
                    </div>`
              }`,
        ),
      },
      {
        id: "lane",
        header: "Lane",
        groupLabel: (value) => laneLabels.get(String(value)) ?? String(value),
      },
      {
        id: "starts",
        header: "Starts",
        sortable: false,
        cell: draw((job) =>
          starts(job).map(
            (start, index) => html`${index === 0 ? "" : ", "}${start}`,
          ),
        ),
      },
      {
        id: "last",
        header: "Last run",
        searchable: false,
        cell: draw((job) =>
          job.lastRun === null
            ? html`<span class="muted">Never</span>`
            : html`<a href=${runHref(job.lastRun.id)}
                  >${stateBadge(job.lastRun.state)}</a
                >
                ${time(job.lastRun.queuedAt)}`,
        ),
      },
      {
        id: "actions",
        header: "",
        sortable: false,
        searchable: false,
        cell: draw(
          (job) => html`<div class="actions">${jobActions(job)}</div>`,
        ),
      },
    ];

    return html`<gw-table
      label="Jobs"
      group="lane"
      row-key="id"
      search="never"
      .columns=${columns}
      .rows=${list.map((job) => ({
        id: job.id,
        name: job.name,
        description: job.description,
        lane: job.lane,
        starts: job.schedule ?? "",
        last: job.lastRun?.queuedAt ?? 0,
      }))}
    ></gw-table>`;
  }

  override render() {
    return html`
      <gw-page-header
        heading="Jobs"
        description="What Upkeep runs, when, and how each last went"
      ></gw-page-header>
      ${view(this.#jobs.value, (list) => this.#table(list))}
      ${
        AsyncResult.isFailure(this.#jobs.value)
          ? null
          : html`<gw-section-title class="runs">Latest runs</gw-section-title>
              <upkeep-runs></upkeep-runs>`
      }
    `;
  }
}

customElements.define("upkeep-overview", UpkeepOverview);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-overview": UpkeepOverview;
  }
}
