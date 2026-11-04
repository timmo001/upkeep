/**
 * `upkeep-run`: one run, what started it, a heal's record when it's a heal,
 * and its log as it grows, with a button to cancel it while it's going.
 */
import { mdiArrowLeft, mdiCancel } from "@mdi/js";
import type { Domain } from "@upkeep/api";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement, type TemplateResult } from "lit";
import { always, AtomController, registry } from "./AtomController.ts";
import {
  attentionBadge,
  capitalise,
  commit,
  duration,
  externalLink,
  formatTime,
  jobName,
  shared,
  stateBadge,
  time,
  view,
} from "./ui.ts";
import {
  cancelRun,
  jobHref,
  jobs,
  run,
  runHref,
  runLog,
  runs,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/gw-alert.ts";
import "@timmo001/groundwork-ui/gw-button.ts";
import "@timmo001/groundwork-ui/gw-page-header.ts";
import "@timmo001/groundwork-ui/gw-section-title.ts";

const going = (state: Domain.RunState) =>
  state === "queued" || state === "running";

const fact = (label: string, value: string | TemplateResult) =>
  html`<dt>${label}</dt>
    <dd>${value}</dd>`;

const target = (heal: Domain.Heal) =>
  heal.target.kind === "upkeep" ? "Upkeep" : heal.target.repo;

const healFacts = (heal: Domain.Heal) => html`
  ${fact("Heals", html`<a href=${runHref(heal.of)}>${jobName(heal.job)}</a>`)}
  ${fact("Target", target(heal))}
  ${heal.decision === null ? null : fact("Decision", capitalise(heal.decision))}
  ${heal.reason === null ? null : fact("Why", heal.reason)}
  ${
    heal.model === null
      ? null
      : fact(
          "Model",
          heal.variant === null
            ? heal.model
            : `${heal.model} (${heal.variant})`,
        )
  }
  ${
    heal.commit === null
      ? null
      : fact(
          "Commit",
          heal.target.kind === "consumer"
            ? externalLink(
                `https://github.com/${heal.target.repo}/commit/${heal.commit}`,
                html`<code>${heal.commit.slice(0, 7)}</code>`,
              )
            : html`<code>${heal.commit}</code>`,
        )
  }
  ${
    heal.actions.length === 0
      ? null
      : fact(
          "Did",
          html`<ul>
            ${heal.actions.map((action) => html`<li>${action}</li>`)}
          </ul>`,
        )
  }
`;

export class UpkeepRun extends LitElement {
  static override properties = { runId: { attribute: false } };

  static override styles = [
    shared,
    css`
      /* Each label lines up with the text or badge beside it */
      dl {
        display: grid;
        grid-template-columns: max-content 1fr;
        align-items: baseline;
        gap: var(--gw-space-2) var(--gw-space-4);
        margin: var(--gw-space-4) 0;
      }

      dt {
        color: var(--gw-color-text-secondary);
      }

      dd {
        margin: 0;
      }

      dd ul {
        margin: 0;
        padding-left: 1.25em;
      }

      pre {
        margin: 0;
        padding: var(--gw-space-3);
        overflow-x: auto;
        border-radius: var(--gw-space-2);
        background: var(--gw-color-surface-lower);
        font-size: var(--gw-font-size-s);
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .line {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: var(--gw-space-3);
      }

      .line time {
        color: var(--gw-color-text-secondary);
      }

      .summary {
        white-space: pre-wrap;
      }

      .changes {
        padding-left: 1.25em;
      }

      .warn {
        color: var(--gw-color-warning);
      }

      .error {
        color: var(--gw-color-danger);
      }
    `,
  ];

  declare runId: string;

  constructor() {
    super();
    this.runId = "";
  }

  readonly #run = new AtomController(
    this,
    () => run(this.runId),
    (current) => !AsyncResult.isSuccess(current) || going(current.value.state),
  );

  readonly #log = new AtomController(this, () => runLog(this.runId));

  readonly #jobs = new AtomController(this, () => jobs, always);

  readonly #runs = new AtomController(this, () => runs(""), always);

  /**
   * What a queued run waits behind: the runs going in its lane, and how many
   * queued before it there. Each worker runs one run per lane at a time.
   */
  #waiting(current: Domain.Run) {
    if (current.state !== "queued") return null;

    const known = AsyncResult.isSuccess(this.#jobs.value)
      ? this.#jobs.value.value
      : [];

    const all = AsyncResult.isSuccess(this.#runs.value)
      ? this.#runs.value.value
      : [];

    const laneOf = (job: string) =>
      known.find((item) => item.id === job)?.lane ?? "repos";

    const lane = laneOf(current.job);
    const inLane = all.filter((item) => laneOf(item.job) === lane);
    const running = inLane.filter((item) => item.state === "running");

    const ahead = inLane.filter(
      (item) =>
        item.state === "queued" &&
        item.id !== current.id &&
        (item.queuedAt < current.queuedAt ||
          (item.queuedAt === current.queuedAt && item.id < current.id)),
    ).length;

    return html`
      ${fact("Lane", capitalise(lane))}
      ${fact(
        "Waiting for",
        running.length === 0
          ? "a worker to take it"
          : html`${running.map(
              (item, index) =>
                html`${index === 0 ? null : ", "}<a href=${runHref(item.id)}
                    >${jobName(item.job)}</a
                  >
                  on ${item.worker ?? "a worker"}`,
            )}${ahead === 0 ? null : html`, then ${ahead} queued before it`}`,
      )}
    `;
  }

  override render() {
    return view(
      this.#run.value,
      (current) => html`
        <gw-page-header heading=${jobName(current.job)}>
          <gw-button
            slot="start"
            href=${jobHref(current.job)}
            appearance="plain"
            variant="neutral"
            icon=${mdiArrowLeft}
            labels="hide"
            >Back</gw-button
          >
          ${
            going(current.state)
              ? html`<gw-button
                  slot="actions"
                  size="small"
                  appearance="outlined"
                  variant="danger"
                  icon=${mdiCancel}
                  @click=${() => registry.set(cancelRun, current.id)}
                  >Cancel</gw-button
                >`
              : null
          }
        </gw-page-header>
        <dl>
          ${fact(
            "State",
            html`${stateBadge(current.state)}
            ${current.attention ? attentionBadge : null}`,
          )}
          ${fact("Trigger", capitalise(current.trigger))}
          ${
            current.release === null
              ? null
              : fact(
                  "Release",
                  externalLink(
                    current.release.url,
                    `${current.release.repo}@${current.release.tag}`,
                  ),
                )
          }
          ${fact("Queued", time(current.queuedAt))} ${this.#waiting(current)}
          ${current.worker === null ? null : fact("Worker", current.worker)}
          ${current.startedAt === null ? null : fact("Took", duration(current))}
          ${current.heal === null ? null : healFacts(current.heal)}
        </dl>
        ${
          current.summary === null
            ? null
            : html`<gw-section-title>Summary</gw-section-title>
                <p class="summary">${current.summary}</p>`
        }
        ${
          current.changes.length === 0
            ? null
            : html`<gw-section-title>Commits</gw-section-title>
                <ul class="changes">
                  ${current.changes.map((change) => html`<li>${commit(change)}</li>`)}
                </ul>`
        }
        ${
          current.error === null
            ? null
            : html`<gw-alert class="message" tone="danger"
                >${current.error}</gw-alert
              >`
        }
        <gw-section-title>Log</gw-section-title>
        ${view(this.#log.value, (lines) =>
          lines.length === 0
            ? html`<p class="muted">
                ${going(current.state) ? "Nothing logged yet." : "No log."}
              </p>`
            : html`<pre>
${lines.map(
                  (line) =>
                    html`<div class="line ${line.level}">
                      <time datetime=${new Date(line.at).toISOString()}
                        >${formatTime(line.at)}</time
                      ><span>${line.message}</span>
                    </div>`,
                )}</pre>`,
        )}
      `,
    );
  }
}

customElements.define("upkeep-run", UpkeepRun);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-run": UpkeepRun;
  }
}
