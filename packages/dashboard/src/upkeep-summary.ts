/**
 * `upkeep-summary`: the foot of the inbox's summary card. The sentences above
 * it are written by plain code; this asks an agent for a longer write-up, on
 * request, through the summary job, then shows the latest one, folded away
 * until it's opened, or that it's being written, while the run goes.
 */
import { Domain } from "@upkeep/api";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement, nothing } from "lit";
import { AtomController, registry } from "./AtomController.ts";
import { phNotePencil } from "./icons.ts";
import { drawn, shared, time, written } from "./ui.ts";
import { runHref, runJob, runs } from "./upkeep.ts";
import "@timmo001/groundwork-ui/gw-button.ts";
import "@timmo001/groundwork-ui/gw-expansion.ts";
import "@timmo001/groundwork-ui/gw-spinner.ts";

const busy = (run: Domain.Run | undefined) =>
  run?.state === "queued" || run?.state === "running";

/** The latest summary run, newest first from the list. */
const latestOf = (
  result: AsyncResult.AsyncResult<ReadonlyArray<Domain.Run>, unknown>,
) => (AsyncResult.isSuccess(result) ? result.value[0] : undefined);

export class UpkeepSummary extends LitElement {
  static override styles = [
    shared,
    css`
      .ask {
        display: flex;
        flex-wrap: wrap;
        gap: var(--gw-space-3);
        align-items: center;
        justify-content: space-between;
        padding-top: var(--gw-space-3);
        margin-top: var(--gw-space-4);
        font-size: var(--gw-font-size-s);
        border-top: var(--gw-border-width) solid var(--gw-color-border-quiet);
      }

      .written {
        margin-top: var(--gw-space-3);
      }

      .status {
        display: flex;
        gap: var(--gw-space-2);
        align-items: center;
        margin: var(--gw-space-3) 0 0;
        font-size: var(--gw-font-size-s);
      }
    `,
  ];

  // Polls only while a write-up is on its way
  readonly #runs = new AtomController(
    this,
    () => runs("summary"),
    (result) => busy(latestOf(result)),
  );

  #ask() {
    registry.set(runJob, "summary");
    registry.refresh(runs("summary"));
  }

  #latest(run: Domain.Run | undefined) {
    if (run === undefined) return nothing;

    if (busy(run)) {
      return html`<p class="status muted">
        <gw-spinner size="small" label="Writing"></gw-spinner>
        An agent is writing it.
        <a href=${runHref(run.id)}>Follow the run</a>
      </p>`;
    }

    if (run.state === "succeeded" && run.summary !== null) {
      const summary = run.summary;

      return html`<gw-expansion
        class="written"
        heading="Agent summary"
        storage-key="upkeep.inbox.summary"
        .draw=${drawn(() => written(summary))}
      ></gw-expansion>`;
    }

    return html`<p class="status muted">
      The last write-up ${run.state === "failed" ? "failed" : "stopped"}.
      <a href=${runHref(run.id)}>Open the run</a>
    </p>`;
  }

  override render() {
    const run = latestOf(this.#runs.value);
    const wrote = run?.state === "succeeded" && run.summary !== null;

    return html`
      <div class="ask">
        <span class="muted"
          >${
            wrote && run.finishedAt !== null
              ? html`An agent summarised
                ${
                  run.period === null
                    ? "the inbox"
                    : Domain.describePeriod(run.period)
                }
                ${time(run.finishedAt)}.`
              : "Written from what Upkeep recorded. No agent was used."
          }</span
        >
        <gw-button
          size="small"
          appearance="outlined"
          variant="neutral"
          icon=${phNotePencil}
          ?disabled=${busy(run)}
          @click=${() => this.#ask()}
          >Summarise in more detail</gw-button
        >
      </div>
      ${this.#latest(run)}
    `;
  }
}

customElements.define("upkeep-summary", UpkeepSummary);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-summary": UpkeepSummary;
  }
}
