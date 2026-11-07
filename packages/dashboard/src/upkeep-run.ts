/**
 * `upkeep-run`: one run, what started it, a heal's record when it's a heal,
 * and its log as it grows, with a button to cancel it while it's going, and
 * once it's ended, to run it again or dismiss what it left for a person.
 */
import { Domain } from "@upkeep/api";
import type {
  TableColumn,
  TableRow,
} from "@timmo001/groundwork-ui/gw-table.ts";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement, render, type TemplateResult } from "lit";
import { always, AtomController, registry } from "./AtomController.ts";
import {
  phArrowCounterClockwise,
  phArrowLeft,
  phCheck,
  phProhibit,
} from "./icons.ts";
import {
  agentLabel,
  agentSession,
  attentionBadge,
  capitalise,
  duration,
  externalLink,
  formatTime,
  jobName,
  shared,
  stateBadge,
  time,
  view,
  written,
} from "./ui.ts";
import { type CellContent, type CellSize, cell } from "./upkeep-cell.ts";
import {
  agents,
  cancelRun,
  dismissRun,
  jobHref,
  jobs,
  retryRun,
  run,
  runHref,
  runLog,
  runs,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-alert.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/gw-page-header.ts";
import "@timmo001/groundwork-ui/define/gw-section-title.ts";
import "@timmo001/groundwork-ui/define/gw-list.ts";
import "@timmo001/groundwork-ui/define/gw-table.ts";

const going = (state: Domain.RunState) =>
  state === "queued" || state === "running";

/** A log line, as `gw-list` draws it. */
const drawLine = (line: Domain.LogLine, target: HTMLElement) => {
  render(
    html`<div class="line ${line.level}">
      <time datetime=${new Date(line.at).toISOString()}
        >${formatTime(line.at)}</time
      ><span>${line.message}</span>
    </div>`,
    target,
  );
};

/** The commits a run pushed, newest first, as a table. */
const changeTable = (changes: ReadonlyArray<Domain.Change>) => {
  const byId = new Map(changes.map((change) => [change.url, change]));

  const draw =
    (content: (change: Domain.Change) => CellContent, size: CellSize) =>
    (row: TableRow) => {
      const change = byId.get(String(row.id));

      return cell(change === undefined ? "" : content(change), size);
    };

  const columns: TableColumn[] = [
    {
      id: "repo",
      header: "Repository",
      cell: draw((change) => change.repo.split("/").at(-1) ?? change.repo, {
        width: "10rem",
      }),
    },
    {
      id: "sha",
      header: "Commit",
      cell: draw(
        (change) =>
          externalLink(
            change.url,
            html`<code>${change.sha.slice(0, 7)}</code>`,
          ),
        { width: "6rem" },
      ),
    },
    {
      id: "subject",
      header: "Change",
      wide: true,
      cell: draw((change) => change.subject, "fill"),
    },
    {
      id: "at",
      header: "When",
      searchable: false,
      cell: draw((change) => time(change.at), { width: "7rem" }),
    },
  ];

  return html`<gw-table
    label="Commits"
    contained
    row-key="id"
    sort="at"
    descending
    search-label="Search commits"
    .columns=${columns}
    .rows=${changes.map((change) => ({
      id: change.url,
      repo: change.repo,
      sha: change.sha,
      subject: change.subject,
      at: change.at,
    }))}
  ></gw-table>`;
};

const fact = (label: string, value: string | TemplateResult) =>
  html`<dt>${label}</dt>
    <dd>${value}</dd>`;

const target = (heal: Domain.Heal) => Domain.targetName(heal.target);

const healFacts = (
  heal: Domain.Heal,
  worker: string | null,
  resumers: ReadonlyArray<string>,
) => html`
  ${fact("Heals", html`<a href=${runHref(heal.of)}>${jobName(heal.job)}</a>`)}
  ${fact("Target", target(heal))}
  ${heal.decision === null ? null : fact("Decision", capitalise(heal.decision))}
  ${
    heal.decision === null
      ? null
      : fact("Decided by", heal.decidedBy ?? "The fallback, without a model")
  }
  ${heal.reason === null ? null : fact("Why", heal.reason)}
  ${
    heal.model === null
      ? null
      : fact("Agent", agentLabel({ model: heal.model, variant: heal.variant }))
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
  ${
    heal.session === null
      ? null
      : fact(
          "Session",
          worker === null || heal.directory === null
            ? html`<code>opencode2 --session ${heal.session}</code>`
            : agentSession(
                {
                  worker,
                  session: heal.session,
                  directory: heal.directory,
                  title: `${jobName(heal.job)} heal for ${target(heal)}`,
                },
                // A shared session opens on any worker that can open one
                heal.shared ? resumers : [worker],
              ),
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

      gw-list.log {
        --gw-list-gap: 0;
        --gw-list-max-height: 36rem;

        padding: var(--gw-space-2) var(--gw-space-3);
        border-radius: var(--gw-space-2);
        background: var(--gw-color-surface-lower);
        font-family: var(--gw-font-mono);
        font-size: var(--gw-font-size-s);
        line-height: 1.5;
      }

      gw-table {
        --gw-table-max-height: 24rem;
      }

      gw-markdown,
      gw-table {
        display: block;
        margin-block-end: var(--gw-space-4);
      }

      .line {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: var(--gw-space-3);
        white-space: pre-wrap;
        word-break: break-word;
      }

      .line time {
        color: var(--gw-color-text-secondary);
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

  readonly #agents = new AtomController(this, () => agents, always);

  /** The workers that can open an agent's session for you. */
  #resumers() {
    return AsyncResult.isSuccess(this.#agents.value)
      ? this.#agents.value.value
          .filter((each) => each.resume)
          .map((each) => each.worker)
      : [];
  }

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
            icon=${phArrowLeft}
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
                  icon=${phProhibit}
                  @click=${() => registry.set(cancelRun, current.id)}
                  >Cancel</gw-button
                >`
              : html`${
                    current.attention
                      ? html`<gw-button
                          slot="actions"
                          size="small"
                          appearance="outlined"
                          variant="neutral"
                          icon=${phCheck}
                          @click=${() => registry.set(dismissRun, current.id)}
                          >Dismiss</gw-button
                        >`
                      : null
                  }
                  <gw-button
                    slot="actions"
                    size="small"
                    appearance="outlined"
                    variant="neutral"
                    icon=${phArrowCounterClockwise}
                    @click=${() => registry.set(retryRun, current.id)}
                    >${current.heal === null ? "Run again" : "Heal again"}</gw-button
                  >`
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
          ${current.heal === null ? null : healFacts(current.heal, current.worker, this.#resumers())}
          ${current.agent === null ? null : fact("Agent", agentLabel(current.agent))}
        </dl>
        ${
          current.summary === null
            ? null
            : html`<gw-section-title>Summary</gw-section-title>
                ${written(current.summary)}`
        }
        ${
          current.changes.length === 0
            ? null
            : html`<gw-section-title>Commits</gw-section-title>
                ${changeTable(current.changes)}`
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
            : html`<gw-list
                class="log"
                label="Log"
                contained
                estimate="22"
                .items=${lines}
                .draw=${drawLine}
              ></gw-list>`,
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
