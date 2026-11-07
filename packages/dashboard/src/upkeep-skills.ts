/**
 * `upkeep-skills`: the held skill changes waiting on you, with their diffs
 * and what to do with each, then every repository's skills: where each comes
 * from, how it stands against its upstream and tools, who keeps a copy and
 * its last commits, with a way to ask an agent for a change to it.
 */
import type { Domain } from "@upkeep/api";
import "@timmo001/groundwork-ui/define/gw-input.ts";
import { GwInput } from "@timmo001/groundwork-ui/gw-input.ts";
import "@timmo001/groundwork-ui/define/gw-popover.ts";
import { GwPopover } from "@timmo001/groundwork-ui/gw-popover.ts";
import type {
  TableColumn,
  TableRow,
} from "@timmo001/groundwork-ui/gw-table.ts";
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { always, AtomController, registry } from "./AtomController.ts";
import { plural } from "./entries.ts";
import {
  phArrowCounterClockwise,
  phCheck,
  phMagnifyingGlass,
  phPaperPlaneRight,
  phPencilSimple,
  phPlay,
  phPuzzlePiece,
  phTerminalWindow,
  phXCircle,
} from "./icons.ts";
import {
  agentSession,
  capitalise,
  drawn,
  empty,
  externalLink,
  shared,
  time,
  view,
  written,
} from "./ui.ts";
import { cell } from "./upkeep-cell.ts";
import {
  approveSkillChange,
  dropSkillChange,
  openSkillChange,
  requestSkillChange,
  reviseSkillChange,
  skillsPage,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/gw-chip.ts";
import "@timmo001/groundwork-ui/define/gw-code.ts";
import "@timmo001/groundwork-ui/define/gw-expansion.ts";
import "@timmo001/groundwork-ui/define/gw-page-header.ts";
import "@timmo001/groundwork-ui/define/gw-section-title.ts";
import "@timmo001/groundwork-ui/define/gw-table.ts";
import "@timmo001/groundwork-ui/define/layout.ts";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const stateTone: Record<Domain.SkillChangeState, Tone> = {
  working: "accent",
  waiting: "warning",
  applying: "accent",
  landed: "success",
  stale: "danger",
  dropped: "neutral",
};

const sourceTone: Record<Domain.SkillSource, Tone> = {
  authored: "accent",
  imported: "neutral",
  adapted: "warning",
  external: "neutral",
};

const fact = (label: string, value: string | TemplateResult) =>
  html`<dt>${label}</dt>
    <dd>${value}</dd>`;

const open = (change: Domain.SkillChange) =>
  change.state !== "landed" && change.state !== "dropped";

/** A worker seen in the last ten minutes is taken to be up. */
const upFor = 10 * 60 * 1000;

/** What the shared prompt is asking for when it saves. */
type Asking =
  | { readonly kind: "revise"; readonly change: Domain.SkillChange }
  | {
      readonly kind: "request";
      readonly repo: string;
      readonly skill: string;
    };

export class UpkeepSkills extends LitElement {
  static override styles = [
    shared,
    css`
      gw-input.search {
        max-width: 24rem;
      }

      dl {
        display: grid;
        grid-template-columns: max-content 1fr;
        align-items: baseline;
        gap: var(--gw-space-2) var(--gw-space-4);
        margin: 0 0 var(--gw-space-4);
      }

      dt {
        color: var(--gw-color-text-secondary);
      }

      dd {
        min-width: 0;
        margin: 0;
      }

      dd ul {
        margin: 0;
        padding-left: 1.25em;
      }

      gw-code,
      gw-table {
        margin-block-end: var(--gw-space-4);
      }

      gw-table {
        --gw-table-max-height: 20rem;
      }

      .muted {
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }
    `,
  ];

  readonly #page = new AtomController(this, () => skillsPage, always);

  #search = "";

  #prompt: GwPopover | undefined;

  #promptInput: GwInput | undefined;

  #asking: Asking | undefined;

  #ask(event: Event, asking: Asking) {
    if (this.#prompt === undefined || this.#promptInput === undefined) return;

    this.#asking = asking;
    this.#prompt.heading =
      asking.kind === "revise"
        ? `Changes to ${asking.change.title}`
        : `A change to ${asking.skill}`;
    this.#promptInput.label =
      asking.kind === "revise" ? "What to change" : "What to ask the agent";
    this.#promptInput.value = "";
    this.requestUpdate();
    this.#prompt.show(
      event.currentTarget instanceof Element ? event.currentTarget : undefined,
    );
  }

  #asked() {
    const text = this.#promptInput?.value.trim() ?? "";
    const choice = this.#prompt?.returnValue ?? "";
    const asking = this.#asking;

    this.#asking = undefined;

    if (asking === undefined || text === "" || choice === "") return;

    if (asking.kind === "revise") {
      registry.set(reviseSkillChange, {
        id: asking.change.id,
        comment: text,
        here: choice === "resume",
      });
    } else {
      registry.set(requestSkillChange, {
        repo: asking.repo,
        skill: asking.skill,
        prompt: text,
      });
    }
  }

  #promptPopover() {
    const asking = this.#asking;

    return html`<gw-popover
      ${ref((element) => {
        this.#prompt = element instanceof GwPopover ? element : undefined;
      })}
      @close=${() => this.#asked()}
    >
      <gw-input
        multiline
        rows="4"
        ${ref((element) => {
          this.#promptInput = element instanceof GwInput ? element : undefined;
        })}
      ></gw-input>
      ${
        asking?.kind === "revise"
          ? html`<gw-button
                slot="actions"
                size="small"
                appearance="outlined"
                variant="neutral"
                value="restart"
                icon=${phArrowCounterClockwise}
                >Start again</gw-button
              ><gw-button
                slot="actions"
                size="small"
                value="resume"
                icon=${phPlay}
                >Resume</gw-button
              >`
          : html`<gw-button
              slot="actions"
              size="small"
              value="ask"
              icon=${phPaperPlaneRight}
              >Ask</gw-button
            >`
      }
    </gw-popover>`;
  }

  #change(change: Domain.SkillChange, workers: Domain.SkillsPage["workers"]) {
    return html`<gw-expansion
      heading=${change.title}
      description=${`${change.repo}, ${capitalise(change.work)}`}
      ?open=${change.state === "waiting"}
      .draw=${drawn(() => this.#changeBody(change, workers))}
    >
      <gw-chip slot="actions" size="xs" tone=${stateTone[change.state]}
        >${change.state}</gw-chip
      >
    </gw-expansion>`;
  }

  /** What a change shows open: why, what the agent said, its diff and actions. */
  #changeBody(
    change: Domain.SkillChange,
    workers: Domain.SkillsPage["workers"],
  ) {
    const worker = workers.find((each) => each.worker === change.worker);
    const up = worker !== undefined && Date.now() - worker.at < upFor;

    return html`<dl>
        ${fact("Why", written(change.reason))}
        ${change.subject === null ? nothing : fact("Commit", change.subject)}
        ${
          change.summary === null
            ? nothing
            : fact("Agent said", written(change.summary))
        }
        ${change.note === null ? nothing : fact("Note", written(change.note))}
        ${
          change.session === null
            ? nothing
            : fact(
                "Session",
                agentSession({
                  worker: change.worker,
                  session: change.session,
                  directory: change.directory,
                  title: change.title,
                }),
              )
        }
        ${fact(
          "Worker",
          html`${change.worker}
            <span class="muted"
              >${
                worker === undefined
                  ? "not seen"
                  : html`seen ${time(worker.at)}`
              }</span
            >`,
        )}
        ${fact("Updated", time(change.at))}
      </dl>
      ${
        change.patch === null
          ? nothing
          : html`<gw-code
              diff
              label=${`The change to ${change.title}`}
              .content=${change.patch}
            ></gw-code>`
      }
      ${
        open(change)
          ? html`<gw-row gap="s">
              ${
                change.state === "waiting"
                  ? html`<gw-button
                      size="small"
                      icon=${phCheck}
                      @click=${() => registry.set(approveSkillChange, change.id)}
                      >Approve</gw-button
                    >`
                  : nothing
              }
              ${
                change.state === "waiting" || change.state === "stale"
                  ? html`<gw-button
                      size="small"
                      appearance="outlined"
                      variant="neutral"
                      icon=${phPencilSimple}
                      @click=${(event: Event) =>
                        this.#ask(event, { kind: "revise", change })}
                      >Request changes</gw-button
                    >`
                  : nothing
              }
              ${
                up && worker.launch
                  ? html`<gw-button
                      size="small"
                      appearance="outlined"
                      variant="neutral"
                      icon=${phTerminalWindow}
                      @click=${() => registry.set(openSkillChange, change.id)}
                      >Open in Herdr</gw-button
                    >`
                  : nothing
              }
              <gw-button
                size="small"
                appearance="outlined"
                variant="danger"
                icon=${phXCircle}
                @click=${() => registry.set(dropSkillChange, change.id)}
                >Drop</gw-button
              >
            </gw-row>`
          : nothing
      }`;
  }

  #skill(repo: string, skill: Domain.SkillInfo) {
    const behind = [
      ...(skill.upstream !== null && skill.upstream.state !== "up-to-date"
        ? [skill.upstream.state.replaceAll("-", " ")]
        : []),
      ...skill.tools
        .filter((tool) => tool.state !== "up-to-date" && tool.latest !== null)
        .map((tool) => `${tool.repo.split("/").at(-1)} ${tool.latest}`),
    ];

    return html`<gw-expansion
      heading=${skill.name}
      description=${skill.description}
      .draw=${drawn(() => this.#skillBody(repo, skill))}
    >
      <gw-chip slot="actions" size="xs" tone=${sourceTone[skill.source]}
        >${skill.source}</gw-chip
      >
      ${behind.map(
        (text) =>
          html`<gw-chip slot="actions" size="xs" tone="warning"
            >${text}</gw-chip
          >`,
      )}
    </gw-expansion>`;
  }

  /** A skill's last commits, newest first, as a table. */
  #commits(repo: string, commits: Domain.SkillInfo["commits"]) {
    const bySha = new Map(commits.map((commit) => [commit.sha, commit]));

    const draw =
      (
        content: (
          commit: Domain.SkillInfo["commits"][number],
        ) => TemplateResult | string,
        width: string | undefined,
      ) =>
      (row: TableRow) => {
        const commit = bySha.get(String(row.id));

        return cell(
          commit === undefined ? "" : content(commit),
          width === undefined ? "fill" : { width },
        );
      };

    const columns: TableColumn[] = [
      {
        id: "sha",
        header: "Commit",
        cell: draw(
          (commit) =>
            externalLink(
              `https://github.com/${repo}/commit/${commit.sha}`,
              html`<code>${commit.sha.slice(0, 7)}</code>`,
            ),
          "6rem",
        ),
      },
      {
        id: "subject",
        header: "Change",
        wide: true,
        cell: draw((commit) => commit.subject, undefined),
      },
      {
        id: "at",
        header: "When",
        searchable: false,
        cell: draw((commit) => time(commit.at), "7rem"),
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
      .rows=${commits.map((commit) => ({
        id: commit.sha,
        sha: commit.sha,
        subject: commit.subject,
        at: commit.at,
      }))}
    ></gw-table>`;
  }

  /** What a skill shows open: where it's from, how it stands, its commits. */
  #skillBody(repo: string, skill: Domain.SkillInfo) {
    return html`<dl>
        ${
          skill.origin === null
            ? nothing
            : fact("From", externalLink(skill.origin, skill.origin))
        }
        ${
          skill.upstream === null
            ? nothing
            : fact(
                "Upstream",
                `${capitalise(skill.upstream.state.replaceAll("-", " "))}${skill.upstream.storedSha === null ? "" : `, at ${skill.upstream.storedSha.slice(0, 7)}`}${skill.upstream.upstreamSha === null ? "" : `, latest ${skill.upstream.upstreamSha.slice(0, 7)}`}${skill.upstream.release === null ? "" : ` (${skill.upstream.release})`}`,
              )
        }
        ${
          skill.localEdits.length === 0
            ? nothing
            : fact(
                "Local edits",
                html`<ul>
                  ${skill.localEdits.map((edit) => html`<li>${edit}</li>`)}
                </ul>`,
              )
        }
        ${
          skill.tools.length === 0
            ? nothing
            : fact(
                "Tools",
                html`<ul>
                  ${skill.tools.map(
                    (tool) =>
                      html`<li>
                        ${externalLink(`https://github.com/${tool.repo}`, tool.repo)},
                        reviewed at
                        ${tool.reviewed}${tool.latest === null || tool.latest === tool.reviewed ? "" : `, latest ${tool.latest}`}
                      </li>`,
                  )}
                </ul>`,
              )
        }
        ${
          skill.copies.length === 0
            ? nothing
            : fact("Copies in", skill.copies.join(", "))
        }
      </dl>
      ${skill.commits.length === 0 ? nothing : this.#commits(repo, skill.commits)}
      <gw-button
        size="small"
        appearance="outlined"
        variant="neutral"
        icon=${phPencilSimple}
        @click=${(event: Event) =>
          this.#ask(event, { kind: "request", repo, skill: skill.name })}
        >Ask for a change</gw-button
      >`;
  }

  #render(page: Domain.SkillsPage) {
    const search = this.#search.trim().toLowerCase();
    const held = page.changes.filter(open);
    const ended = page.changes.filter((change) => !open(change));

    return html`
      <gw-stack gap="l">
        <gw-page-header
          heading="Skills"
          description="Held skill changes waiting on you, and every repository's skills"
        ></gw-page-header>
        <gw-section-title>Changes</gw-section-title>
        ${
          held.length === 0
            ? empty(phCheck, "No skill changes are waiting.")
            : html`<gw-stack gap="s">
                ${held.map((change) => this.#change(change, page.workers))}
              </gw-stack>`
        }
        ${
          ended.length === 0
            ? nothing
            : html`<gw-expansion
                heading="Ended lately"
                description=${plural(ended.length, "change")}
                storage-key="upkeep.skills.ended"
                .draw=${drawn(
                  () =>
                    html`<gw-stack gap="s">
                      ${ended.map((change) => this.#change(change, page.workers))}
                    </gw-stack>`,
                )}
              ></gw-expansion>`
        }
        <gw-input
          class="search"
          label="Search skills"
          label-hidden
          placeholder="Search skills"
          icon=${phMagnifyingGlass}
          .value=${this.#search}
          @input=${(event: Event) => {
            const target = event.currentTarget;

            this.#search = target instanceof GwInput ? target.value : "";
            this.requestUpdate();
          }}
        ></gw-input>
        ${
          page.repos.length === 0
            ? empty(
                phPuzzlePiece,
                "No skills yet: they show once skill-updates has run.",
              )
            : page.repos.map((snapshot) => {
                const shown = snapshot.skills.filter(
                  (skill) =>
                    search === "" ||
                    skill.name.toLowerCase().includes(search) ||
                    skill.description.toLowerCase().includes(search),
                );

                return html`<gw-stack gap="s">
                  <gw-section-title
                    >${snapshot.repo}
                    <span class="muted"
                      >${plural(snapshot.skills.length, "skill")}, read
                      ${time(snapshot.checkedAt)}</span
                    ></gw-section-title
                  >
                  ${
                    shown.length === 0
                      ? empty(phMagnifyingGlass, "No skill matches.")
                      : shown.map((skill) => this.#skill(snapshot.repo, skill))
                  }
                </gw-stack>`;
              })
        }
      </gw-stack>
      ${this.#promptPopover()}
    `;
  }

  override render() {
    return view(this.#page.value, (page) => this.#render(page));
  }
}

customElements.define("upkeep-skills", UpkeepSkills);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-skills": UpkeepSkills;
  }
}
