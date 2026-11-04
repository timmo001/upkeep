/**
 * `upkeep-runs`: the latest runs, of every job or the one in `job`, kept up
 * to date while it's on screen.
 */
import { mdiHistory } from "@mdi/js";
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
import { jobHref, jobs, runHref, runs } from "./upkeep.ts";

const release = (run: Domain.Run) =>
  run.release === null
    ? ""
    : externalLink(run.release.url, `${run.release.repo}@${run.release.tag}`);

export class UpkeepRuns extends LitElement {
  static override properties = { job: {} };

  static override styles = [
    shared,
    css`
      td.summary {
        min-width: 16em;
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

  override render() {
    return view(this.#runs.value, (all) => {
      // Every job's runs leave out the ones that found nothing to do, which
      // a job's own page still lists
      const list =
        this.job === "" ? all.filter((run) => run.state !== "skipped") : all;

      return list.length === 0
        ? empty(mdiHistory, "No runs yet.")
        : html`<div class="table">
            <table>
              <thead>
                <tr>
                  <th>State</th>
                  ${this.job === "" ? html`<th>Job</th>` : null}
                  <th>Trigger</th>
                  <th>What it did</th>
                  <th>Release</th>
                  <th>Worker</th>
                  <th>Queued</th>
                  <th>Took</th>
                </tr>
              </thead>
              <tbody>
                ${list.map(
                  (run) =>
                    html`<tr>
                      <td>
                        <a href=${runHref(run.id)}>${stateBadge(run.state)}</a>
                      </td>
                      ${
                        this.job === ""
                          ? html`<td>
                              <a href=${jobHref(run.job)}>${run.job}</a>
                            </td>`
                          : null
                      }
                      <td>
                        ${run.trigger}${
                          run.heal === null
                            ? ""
                            : html` of
                                <a href=${runHref(run.heal.of)}
                                  >${run.heal.job}</a
                                >`
                        }
                      </td>
                      <td class="summary">
                        ${run.attention ? attentionBadge : null}
                        ${run.summary?.split("\n")[0] ?? ""}
                      </td>
                      <td>${release(run)}</td>
                      <td>
                        ${
                          run.state === "queued"
                            ? html`<span class="muted"
                                >waiting in the ${this.#laneOf(run.job)}
                                lane</span
                              >`
                            : (run.worker ?? "")
                        }
                      </td>
                      <td>${time(run.queuedAt)}</td>
                      <td>${duration(run)}</td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`;
    });
  }
}

customElements.define("upkeep-runs", UpkeepRuns);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-runs": UpkeepRuns;
  }
}
