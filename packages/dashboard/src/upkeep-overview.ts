/**
 * `upkeep-overview`: the Jobs page. Every job, grouped by the lane it runs
 * in, with its latest run, a button to run it (unless it runs on releases,
 * which need one given) and, for a parked job, why and
 * a button to unpark it, and a switch to pause or resume one that starts by
 * itself; then each
 * worker's agents, with their roles, models and what they're for; then the
 * latest runs. Each table starts with its groups folded away.
 */
import type {
  TableColumn,
  TableRow,
} from "@timmo001/groundwork-ui/gw-table.ts";
import type { Domain } from "@upkeep/api";
import cronstrue from "cronstrue";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement } from "lit";
import { always, AtomController, registry } from "./AtomController.ts";
import { phPause, phPlay, phPlayPause } from "./icons.ts";
import {
  agentLabel,
  formatTime,
  shared,
  stateBadge,
  time,
  view,
} from "./ui.ts";
import { type CellContent, type CellSize, cell } from "./upkeep-cell.ts";
import {
  agents,
  jobHref,
  jobs,
  pauseJob,
  resumeJob,
  runHref,
  runJob,
  unparkJob,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/gw-page-header.ts";
import "@timmo001/groundwork-ui/define/gw-section.ts";
import "@timmo001/groundwork-ui/define/gw-table.ts";
import "./upkeep-runs.ts";

/** Each lane's heading: a lane runs one run at a time, so a job waits only behind its own lane. */
const laneLabels = new Map<string, string>([
  ["quick", "Quick lane: short jobs"],
  ["repos", "Repositories lane: jobs that change repositories"],
  ["checks", "Checks lane: jobs that read repositories without pushing"],
  ["heal", "Heal lane: fixes for failed runs"],
  ["command", "Command lane: what the dashboard asks for"],
  ["machine", "Machine lane: keeping each worker's own machine current"],
]);

/** Whether only a person starts a job: it has no schedule and no release. */
const onRequest = (job: Domain.JobStatus) =>
  job.schedule === null && !job.onRelease;

/** What starts a job besides its run button, with a schedule in words. */
const starts = (job: Domain.JobStatus) =>
  onRequest(job)
    ? ["On request"]
    : [
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
  ${
    // A job that runs on releases needs one, which the button can't give
    job.onRelease
      ? null
      : html`<gw-button
          size="small"
          appearance="filled"
          icon=${phPlay}
          @click=${() => registry.set(runJob, job.id)}
          >Run</gw-button
        >`
  }
  ${
    job.parked === null
      ? null
      : html`<gw-button
          size="small"
          appearance="outlined"
          variant="warning"
          icon=${phPlayPause}
          @click=${() => registry.set(unparkJob, job.id)}
          >Unpark</gw-button
        >`
  }
  ${
    // Pausing only stops what queues it by itself, which a job run on
    // request doesn't have, but one paused before can still be resumed
    job.paused === null
      ? onRequest(job)
        ? null
        : html`<gw-button
            size="small"
            appearance="outlined"
            variant="neutral"
            icon=${phPause}
            title="Stop queueing it until it's resumed"
            @click=${() => registry.set(pauseJob, job.id)}
            >Pause</gw-button
          >`
      : html`<gw-button
          size="small"
          appearance="outlined"
          variant="warning"
          icon=${phPlay}
          @click=${() => registry.set(resumeJob, job.id)}
          >Resume</gw-button
        >`
  }
`;

export class UpkeepOverview extends LitElement {
  static override styles = [
    shared,
    css`
      .section {
        margin-top: var(--gw-space-6);
      }

      gw-page-header {
        margin-bottom: var(--gw-space-4);
      }
    `,
  ];

  readonly #jobs = new AtomController(this, () => jobs, always);

  readonly #workers = new AtomController(this, () => agents, always);

  /** The jobs as a table, grouped by the lane each runs in. */
  #table(list: ReadonlyArray<Domain.JobStatus>) {
    const byId = new Map(list.map((job) => [job.id, job]));

    // Every column but the job's name has a fixed width, so the columns keep
    // their size as runs finish and jobs pause or park
    const draw =
      (content: (job: Domain.JobStatus) => CellContent, size?: CellSize) =>
      (row: TableRow) => {
        const job = byId.get(String(row.id));

        return cell(job === undefined ? "" : content(job), size);
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
        cell: draw(
          (job) =>
            starts(job).map(
              (start, index) => html`${index === 0 ? "" : ", "}${start}`,
            ),
          { width: "12rem" },
        ),
      },
      {
        id: "last",
        header: "Last run",
        searchable: false,
        cell: draw(
          (job) =>
            job.machines !== undefined && job.machines.length > 0
              ? job.machines.map(
                  (run) =>
                    html`<div>
                      <a href=${runHref(run.id)}>${stateBadge(run.state)}</a>
                      ${
                        run.command?.kind === "machine"
                          ? run.command.worker
                          : ""
                      },
                      ${time(run.queuedAt)}
                    </div>`,
                )
              : job.lastRun === null
                ? html`<span class="muted">Never</span>`
                : html`<a href=${runHref(job.lastRun.id)}
                      >${stateBadge(job.lastRun.state)}</a
                    >
                    ${time(job.lastRun.queuedAt)}`,
          { width: "14rem" },
        ),
      },
      {
        id: "actions",
        header: "",
        sortable: false,
        searchable: false,
        cell: draw(
          (job) => html`<div class="actions">${jobActions(job)}</div>`,
          // Wraps, so a parked job's third button doesn't widen the column
          { width: "12rem", wrap: true },
        ),
      },
    ];

    return html`<gw-table
      storage-key="upkeep.jobs.table"
      label="Jobs"
      group="lane"
      groups-collapsed
      contained
      row-key="id"
      search="never"
      .columns=${columns}
      .rows=${list.map((job) => ({
        id: job.id,
        name: job.name,
        description: job.description,
        lane: job.lane,
        starts: onRequest(job) ? "On request" : (job.schedule ?? ""),
        last: job.lastRun?.queuedAt ?? 0,
      }))}
    ></gw-table>`;
  }

  /** Each worker's agents, one row per role, grouped by worker. */
  #agents(list: ReadonlyArray<Domain.WorkerAgents>) {
    if (list.length === 0)
      return html`<p class="muted">
        No worker has said which agents it has yet.
      </p>`;

    const rows = list.flatMap((worker) => [
      {
        id: `${worker.worker}:decisions`,
        worker: `${worker.worker}, as of ${formatTime(worker.at)}`,
        role: "Decisions",
        model: worker.decisions ?? "None",
        for:
          worker.decisions === null
            ? "Without a model, lost runs are retried and other failures are left for you"
            : "Chooses to retry, fix, park or ask, and picks the agent for a fix",
      },
      ...worker.agents.map((agent, index) => ({
        id: `${worker.worker}:${index}`,
        worker: `${worker.worker}, as of ${formatTime(worker.at)}`,
        role: [
          "Fix",
          ...(index === 0 ? ["the default", "summaries"] : []),
          ...(index === worker.agents.length - 1
            ? ["the heals the decision model isn't sure about"]
            : []),
        ].join(", "),
        model: agentLabel(agent),
        for: agent.for,
      })),
    ]);

    const columns: TableColumn[] = [
      { id: "worker", header: "Worker" },
      { id: "role", header: "Role" },
      { id: "model", header: "Model" },
      { id: "for", header: "For", wide: true },
    ];

    return html`<gw-table
      storage-key="upkeep.agents.table"
      label="Agents"
      group="worker"
      groups-collapsed
      contained
      row-key="id"
      search="never"
      .columns=${columns}
      .rows=${rows}
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
          : html`<gw-section
                class="section"
                heading="Agents"
                storage-key="upkeep.jobs.section.agents"
              >
                ${view(this.#workers.value, (list) => this.#agents(list))}
              </gw-section>
              <gw-section
                class="section"
                heading="Latest runs"
                storage-key="upkeep.jobs.section.runs"
              >
                <upkeep-runs groups-collapsed></upkeep-runs>
              </gw-section>`
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
