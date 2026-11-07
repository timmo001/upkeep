/**
 * `upkeep-job`: one job, what starts it, whether it's parked, the heals of
 * its consumers waiting on the heal limit, and its runs.
 */
import { css, html, LitElement } from "lit";
import { always, AtomController } from "./AtomController.ts";
import { phArrowLeft } from "./icons.ts";
import { empty, shared, time, view } from "./ui.ts";
import { jobs, jobsHref, runHref } from "./upkeep.ts";
import { jobActions } from "./upkeep-overview.ts";
import "@timmo001/groundwork-ui/define/gw-alert.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/gw-page-header.ts";
import "./upkeep-runs.ts";

export class UpkeepJob extends LitElement {
  static override properties = { jobId: { attribute: false } };

  static override styles = [
    shared,
    css`
      upkeep-runs {
        margin-top: var(--gw-space-4);
      }
    `,
  ];

  declare jobId: string;

  constructor() {
    super();
    this.jobId = "";
  }

  readonly #jobs = new AtomController(this, () => jobs, always);

  override render() {
    return view(this.#jobs.value, (list) => {
      const job = list.find((candidate) => candidate.id === this.jobId);

      if (job === undefined) return empty(phArrowLeft, "There's no such job.");

      return html`
        <gw-page-header heading=${job.name} description=${job.description}>
          <gw-button
            slot="start"
            href=${jobsHref}
            appearance="plain"
            variant="neutral"
            icon=${phArrowLeft}
            labels="hide"
            >Back</gw-button
          >
          <div slot="actions">${jobActions(job)}</div>
        </gw-page-header>
        ${
          job.parked === null
            ? null
            : html`<gw-alert class="message" tone="warning" heading="Parked">
                ${job.parked.reason}, ${time(job.parked.at)}.
                ${
                  job.parked.issue === null
                    ? ""
                    : html`It unparks once its triage issue is resolved.`
                }
              </gw-alert>`
        }
        ${
          job.paused === null
            ? null
            : html`<gw-alert class="message" tone="neutral" heading="Paused">
                ${job.paused.by} paused it ${time(job.paused.at)}. Nothing
                queues it until it's resumed, but it can still be run by hand.
              </gw-alert>`
        }
        ${
          (job.waiting ?? []).length === 0
            ? null
            : html`<gw-alert
                class="message"
                tone="neutral"
                heading="Heals waiting"
              >
                ${(job.waiting ?? []).map(
                  (waiting, index) =>
                    html`${index === 0 ? "" : ", "}<a
                        href=${runHref(waiting.run)}
                        >${waiting.repo}</a
                      >
                      since ${time(waiting.at)}`,
                )}.
                Each used its heals for the last 24 hours, so its heal is queued
                once one frees up.
              </gw-alert>`
        }
        <upkeep-runs .job=${job.id}></upkeep-runs>
      `;
    });
  }
}

customElements.define("upkeep-job", UpkeepJob);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-job": UpkeepJob;
  }
}
