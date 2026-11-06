/**
 * `upkeep-skills`: the held skill changes waiting on you, with their diffs
 * and what to do with each, then every repository's skills: where each comes
 * from, how it stands against its upstream and tools, who keeps a copy and
 * its last commits, with a way to ask an agent for a change to it.
 */
import {
  mdiCheck,
  mdiCloseCircleOutline,
  mdiConsole,
  mdiMagnify,
  mdiPencilOutline,
  mdiPuzzleOutline,
} from "@mdi/js";
import type { Domain } from "@upkeep/api";
import { GwInput } from "@timmo001/groundwork-ui/gw-input.ts";
import { GwPopover } from "@timmo001/groundwork-ui/gw-popover.ts";
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { always, AtomController, registry } from "./AtomController.ts";
import { plural } from "./entries.ts";
import {
  agentSession,
  capitalise,
  empty,
  externalLink,
  shared,
  time,
  view,
} from "./ui.ts";
import {
  approveSkillChange,
  dropSkillChange,
  openSkillChange,
  requestSkillChange,
  reviseSkillChange,
  skillsPage,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/gw-button.ts";
import "@timmo001/groundwork-ui/gw-chip.ts";
import "@timmo001/groundwork-ui/gw-expansion.ts";
import "@timmo001/groundwork-ui/gw-page-header.ts";
import "@timmo001/groundwork-ui/gw-section-title.ts";
import "@timmo001/groundwork-ui/layout.ts";

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
        margin: 0;
        white-space: pre-wrap;
      }

      dd ul {
        margin: 0;
        padding-left: 1.25em;
      }

      pre {
        margin: 0;
        padding: var(--gw-space-3);
        max-height: 32rem;
        overflow: auto;
        border-radius: var(--gw-space-2);
        background: var(--gw-color-surface-lower);
        font-size: var(--gw-font-size-s);
        line-height: 1.5;
      }

      .add {
        color: var(--gw-color-success, green);
      }

      .remove {
        color: var(--gw-color-danger, red);
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
                >Start again</gw-button
              ><gw-button slot="actions" size="small" value="resume"
                >Resume</gw-button
              >`
          : html`<gw-button slot="actions" size="small" value="ask"
              >Ask</gw-button
            >`
      }
    </gw-popover>`;
  }

  /** A patch with its added and removed lines tinted. */
  #patch(patch: string) {
    return html`<pre>
${patch.split("\n").map((line) => {
        const kind =
          line.startsWith("+") && !line.startsWith("+++")
            ? "add"
            : line.startsWith("-") && !line.startsWith("---")
              ? "remove"
              : "";

        return html`<span class=${kind}>${line}</span> `;
      })}</pre>`;
  }

  #change(change: Domain.SkillChange, workers: Domain.SkillsPage["workers"]) {
    const worker = workers.find((each) => each.worker === change.worker);
    const up = worker !== undefined && Date.now() - worker.at < upFor;

    return html`<gw-expansion
      heading=${change.title}
      description=${`${change.repo}, ${capitalise(change.work)}`}
      ?open=${change.state === "waiting"}
    >
      <gw-chip slot="actions" size="xs" tone=${stateTone[change.state]}
        >${change.state}</gw-chip
      >
      <dl>
        ${fact("Why", change.reason)}
        ${change.subject === null ? nothing : fact("Commit", change.subject)}
        ${change.summary === null ? nothing : fact("Agent said", change.summary)}
        ${change.note === null ? nothing : fact("Note", change.note)}
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
      ${change.patch === null ? nothing : this.#patch(change.patch)}
      ${
        open(change)
          ? html`<gw-row gap="s">
              ${
                change.state === "waiting"
                  ? html`<gw-button
                      size="small"
                      icon=${mdiCheck}
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
                      icon=${mdiPencilOutline}
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
                      icon=${mdiConsole}
                      @click=${() => registry.set(openSkillChange, change.id)}
                      >Open in Herdr</gw-button
                    >`
                  : nothing
              }
              <gw-button
                size="small"
                appearance="outlined"
                variant="danger"
                icon=${mdiCloseCircleOutline}
                @click=${() => registry.set(dropSkillChange, change.id)}
                >Drop</gw-button
              >
            </gw-row>`
          : nothing
      }
    </gw-expansion>`;
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
      <dl>
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
        ${
          skill.commits.length === 0
            ? nothing
            : fact(
                "Commits",
                html`<ul>
                  ${skill.commits.map(
                    (commit) =>
                      html`<li>
                        ${externalLink(
                          `https://github.com/${repo}/commit/${commit.sha}`,
                          html`<code>${commit.sha.slice(0, 7)}</code>`,
                        )}
                        ${commit.subject}
                        <span class="muted">${time(commit.at)}</span>
                      </li>`,
                  )}
                </ul>`,
              )
        }
      </dl>
      <gw-button
        size="small"
        appearance="outlined"
        variant="neutral"
        icon=${mdiPencilOutline}
        @click=${(event: Event) =>
          this.#ask(event, { kind: "request", repo, skill: skill.name })}
        >Ask for a change</gw-button
      >
    </gw-expansion>`;
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
            ? empty(mdiCheck, "No skill changes are waiting.")
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
              >
                <gw-stack gap="s">
                  ${ended.map((change) => this.#change(change, page.workers))}
                </gw-stack>
              </gw-expansion>`
        }
        <gw-input
          class="search"
          label="Search skills"
          label-hidden
          placeholder="Search skills"
          icon=${mdiMagnify}
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
                mdiPuzzleOutline,
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
                      ? empty(mdiMagnify, "No skill matches.")
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
