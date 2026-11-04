/**
 * `upkeep-overview`: a summary of the last day, with what needs a person and
 * the commits pushed; every job with its latest run, a button to run it and,
 * for a parked job, why and a button to unpark it; then the latest runs.
 */
import { mdiPlay, mdiPlayPause } from "@mdi/js";
import type { Domain } from "@upkeep/api";
import cronstrue from "cronstrue";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement } from "lit";
import { always, AtomController, registry } from "./AtomController.ts";
import { commit, shared, stateBadge, time, view } from "./ui.ts";
import {
  activity,
  jobHref,
  jobs,
  runHref,
  runJob,
  unparkJob,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/gw-button.ts";
import "@timmo001/groundwork-ui/gw-section-title.ts";
import "./upkeep-runs.ts";

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
`;

export class UpkeepOverview extends LitElement {
  static override styles = [
    shared,
    css`
      .actions {
        display: flex;
        gap: var(--gw-space-2);
        justify-content: end;
      }

      .parked {
        color: var(--gw-color-warning);
      }

      upkeep-runs {
        margin-top: var(--gw-space-3);
      }

      .runs {
        display: block;
        margin-top: var(--gw-space-6);
      }

      .last {
        white-space: nowrap;
      }

      .tldr {
        margin-block: var(--gw-space-3);
      }

      .attention li {
        color: var(--gw-color-warning);
      }

      .changes,
      .attention {
        padding-left: 1.25em;
      }

      .changes li {
        margin-block: var(--gw-space-1);
      }

      .commits {
        display: block;
        margin-top: var(--gw-space-4);
      }
    `,
  ];

  readonly #jobs = new AtomController(this, () => jobs, always);

  readonly #activity = new AtomController(this, () => activity, always);

  #tldr(day: Domain.Activity) {
    const { runs } = day;

    const counts = [
      `${runs.succeeded} succeeded`,
      runs.failed === 0 ? null : `${runs.failed} failed`,
      runs.heals === 0 ? null : `${runs.heals} heals`,
      runs.skipped === 0 ? null : `${runs.skipped} skipped`,
      runs.cancelled === 0 ? null : `${runs.cancelled} cancelled`,
    ].filter((count) => count !== null);

    const repos = new Set(day.changes.map((change) => change.repo)).size;

    return html`
      <p class="tldr">
        In the last day: ${counts.join(", ")};
        ${
          day.changes.length === 0
            ? "no commits pushed"
            : `${day.changes.length} ${day.changes.length === 1 ? "commit" : "commits"} pushed to ${repos} ${repos === 1 ? "repository" : "repositories"}`
        }${
          day.attention.length === 0
            ? ", nothing needs you."
            : html`, and ${day.attention.length} need you.`
        }
      </p>
      ${
        day.attention.length === 0
          ? null
          : html`<ul class="attention">
              ${day.attention.map(
                (item) =>
                  html`<li>
                    <a href=${runHref(item.id)}>${item.job}</a>
                    ${time(item.finishedAt ?? item.queuedAt)}:
                    ${item.summary ?? item.error ?? "see its log"}
                  </li>`,
              )}
            </ul>`
      }
      ${
        day.changes.length === 0
          ? null
          : html`<gw-section-title class="commits"
                >Recent commits</gw-section-title
              >
              <ul class="changes">
                ${day.changes.slice(0, 20).map(
                  (change) =>
                    html`<li>
                      ${commit(change)}
                      <span class="muted"
                        >by
                        <a href=${runHref(change.run)}>${change.job}</a>
                        ${time(change.at)}</span
                      >
                    </li>`,
                )}
              </ul>`
      }
    `;
  }

  override render() {
    return html`
      <gw-section-title>Today</gw-section-title>
      ${view(this.#activity.value, (day) => this.#tldr(day))}
      <gw-section-title class="runs">Jobs</gw-section-title>
      ${view(
        this.#jobs.value,
        (list) =>
          html`<div class="table">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Starts</th>
                  <th>Last run</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${list.map(
                  (job) =>
                    html`<tr>
                      <td>
                        <a href=${jobHref(job.id)}>${job.name}</a>
                        <div class="muted">${job.description}</div>
                        ${
                          job.parked === null
                            ? null
                            : html`<div class="parked">
                                Parked ${time(job.parked.at)}:
                                ${job.parked.reason}
                              </div>`
                        }
                      </td>
                      <td>
                        ${starts(job).map((start, index) => html`${index === 0 ? "" : ", "}${start}`)}
                      </td>
                      <td class="last">
                        ${
                          job.lastRun === null
                            ? html`<span class="muted">Never</span>`
                            : html`<a href=${runHref(job.lastRun.id)}
                                  >${stateBadge(job.lastRun.state)}</a
                                >
                                ${time(job.lastRun.queuedAt)}`
                        }
                      </td>
                      <td><div class="actions">${jobActions(job)}</div></td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`,
      )}
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
