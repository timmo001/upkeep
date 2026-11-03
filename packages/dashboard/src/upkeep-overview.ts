/**
 * `upkeep-overview`: every job with its latest run, a button to run it and,
 * for a parked job, why and a button to unpark it; then the latest runs.
 */
import { mdiPlay, mdiPlayPause } from "@mdi/js";
import type { Domain } from "@upkeep/api";
import { css, html, LitElement } from "lit";
import { always, AtomController, registry } from "./AtomController.ts";
import { shared, stateBadge, time, view } from "./ui.ts";
import { jobHref, jobs, runHref, runJob, unparkJob } from "./upkeep.ts";
import "@timmo001/groundwork-ui/gw-button.ts";
import "@timmo001/groundwork-ui/gw-section-title.ts";
import "./upkeep-runs.ts";

/** What starts a job besides its run button. */
const starts = (job: Domain.JobStatus) =>
  [
    job.schedule === null ? null : html`<code>${job.schedule}</code>`,
    job.onRelease ? "on release" : null,
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
    `,
  ];

  readonly #jobs = new AtomController(this, () => jobs, always);

  override render() {
    return html`
      <gw-section-title>Jobs</gw-section-title>
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
                      <td>
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
      <gw-section-title>Latest runs</gw-section-title>
      <upkeep-runs></upkeep-runs>
    `;
  }
}

customElements.define("upkeep-overview", UpkeepOverview);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-overview": UpkeepOverview;
  }
}
