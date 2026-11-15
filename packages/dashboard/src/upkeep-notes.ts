/**
 * `upkeep-notes`: the standing notes for one scope (a repository, Upkeep
 * itself or the attention agent), which the agents working there read.
 * Yours and the agents' alike can be edited or deleted here, and one an agent
 * flagged as out of date can be kept or dropped.
 */
import "@timmo001/groundwork-ui/define/gw-input.ts";
import { GwInput } from "@timmo001/groundwork-ui/gw-input.ts";
import "@timmo001/groundwork-ui/define/gw-popover.ts";
import { GwPopover } from "@timmo001/groundwork-ui/gw-popover.ts";
import { Domain } from "@upkeep/api";
import { css, html, LitElement, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { always, AtomController, registry } from "./AtomController.ts";
import {
  phCheck,
  phPencilSimple,
  phPlus,
  phRobot,
  phTrash,
  phUser,
} from "./icons.ts";
import { icon, shared, time, view } from "./ui.ts";
import {
  addNote,
  dayRange,
  editNote,
  keepNote,
  notes,
  removeNote,
  runHref,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-alert.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/layout.ts";

/** A local day as `YYYY-MM-DD`, for the date input. */
const localDay = (millis: number) => {
  const date = new Date(millis);

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
};

export class UpkeepNotes extends LitElement {
  static override properties = {
    scope: {},
    empty: {},
  };

  static override styles = [
    shared,
    css`
      ul {
        display: grid;
        gap: var(--gw-space-3);
        margin: 0;
        padding: 0;
        list-style: none;
      }

      li {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: var(--gw-space-2);
        align-items: start;
      }

      li > .icon {
        margin-top: 0.15em;
        color: var(--gw-color-text-secondary);
      }

      .text {
        margin: 0;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }

      .meta {
        margin: 0;
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }

      .expired .text {
        color: var(--gw-color-text-secondary);
        text-decoration: line-through;
      }

      .row-actions {
        display: flex;
        gap: var(--gw-space-1);
      }

      gw-alert {
        grid-column: 2 / -1;
      }
    `,
  ];

  /** `owner/name`, `upkeep` or `attention`. */
  declare scope: string;

  /** What shows when there are none yet. */
  declare empty: string;

  readonly #notes = new AtomController(this, () => notes, always);

  #popover: GwPopover | undefined;

  #text: GwInput | undefined;

  #expires: GwInput | undefined;

  /** The note being edited, or null when adding one. */
  #editing: Domain.Note | null = null;

  constructor() {
    super();
    this.scope = "";
    this.empty = "None yet.";
  }

  #open(event: Event, note: Domain.Note | null) {
    if (this.#text === undefined || this.#expires === undefined) return;

    this.#editing = note;
    this.#text.value = note?.text ?? "";

    if (this.#popover !== undefined) {
      this.#popover.heading = note === null ? "New note" : "Edit note";
    }

    this.#expires.value =
      note?.expiresAt === null || note?.expiresAt === undefined
        ? ""
        : localDay(note.expiresAt - 1);

    this.#popover?.show(
      event.currentTarget instanceof Element ? event.currentTarget : undefined,
    );
  }

  /** Save what was typed, as the popover closed with Save. */
  #saved() {
    const text = this.#text?.value.trim() ?? "";
    const day = this.#expires?.value ?? "";
    const editing = this.#editing;

    this.#editing = null;

    if (this.#popover?.returnValue !== "save" || text === "") return;

    // A note expires once the day it's set to is over
    const expiresAt = day === "" ? null : dayRange(day).until;

    if (editing === null) {
      registry.set(addNote, { scope: this.scope, text, expiresAt });
    } else {
      registry.set(editNote, { id: editing.id, text, expiresAt });
    }
  }

  #who(note: Domain.Note) {
    if (note.run !== null) {
      return html`by an agent in <a href=${runHref(note.run)}>its run</a>`;
    }

    return note.comment === null ? html`by you` : html`from your comment`;
  }

  #expiry(note: Domain.Note, now: number) {
    if (note.expiresAt === null) return nothing;

    return Domain.noteCurrent(note, now)
      ? html`, expires ${time(note.expiresAt)}`
      : html`, expired ${time(note.expiresAt)} so no agent reads it`;
  }

  #stale(note: Domain.Note) {
    if (note.stale === null) return nothing;

    return html`<gw-alert tone="warning" heading="May be out of date">
      ${
        note.stale.run === null
          ? "Flagged"
          : html`An agent said so in
              <a href=${runHref(note.stale.run)}>its run</a>`
      }
      ${time(note.stale.at)}: ${note.stale.reason}
      <div class="actions">
        <gw-button
          size="xs"
          appearance="outlined"
          variant="neutral"
          icon=${phCheck}
          @click=${() => registry.set(keepNote, note.id)}
          >Keep it</gw-button
        >
        <gw-button
          size="xs"
          appearance="outlined"
          variant="danger"
          icon=${phTrash}
          @click=${() => registry.set(removeNote, note.id)}
          >Delete it</gw-button
        >
      </div>
    </gw-alert>`;
  }

  #note(note: Domain.Note, now: number) {
    return html`<li class=${Domain.noteCurrent(note, now) ? "" : "expired"}>
      ${icon(note.run === null ? phUser : phRobot)}
      <div>
        <p class="text">${note.text}</p>
        <p class="meta">
          Written ${this.#who(note)}
          ${time(note.createdAt)}${this.#expiry(note, now)}
        </p>
      </div>
      <div class="row-actions">
        <gw-button
          size="xs"
          appearance="plain"
          variant="neutral"
          labels="hide"
          icon=${phPencilSimple}
          @click=${(event: Event) => this.#open(event, note)}
          >Edit</gw-button
        >
        <gw-button
          size="xs"
          appearance="plain"
          variant="neutral"
          labels="hide"
          icon=${phTrash}
          @click=${() => registry.set(removeNote, note.id)}
          >Delete</gw-button
        >
      </div>
      ${this.#stale(note)}
    </li>`;
  }

  #popoverTemplate() {
    return html`<gw-popover
      ${ref((element) => {
        this.#popover = element instanceof GwPopover ? element : undefined;
      })}
      @close=${() => this.#saved()}
    >
      <gw-stack gap="s">
        <gw-input
          label="Note"
          multiline
          rows="3"
          hint="Such as: its end-to-end tests need the mock server running"
          ${ref((element) => {
            this.#text = element instanceof GwInput ? element : undefined;
          })}
        ></gw-input>
        <gw-input
          label="Expires on"
          type="date"
          optional
          hint="Leave it empty to keep it until you delete it"
          ${ref((element) => {
            this.#expires = element instanceof GwInput ? element : undefined;
          })}
        ></gw-input>
      </gw-stack>
      <gw-button slot="actions" size="small" value="save" icon=${phCheck}
        >Save</gw-button
      >
    </gw-popover>`;
  }

  override render() {
    return html`${view(this.#notes.value, (all) => {
      const now = Date.now();
      const scope = this.scope.toLowerCase();

      const mine = all.filter((note) => note.scope.toLowerCase() === scope);

      return html`<gw-stack gap="s">
        ${
          mine.length === 0
            ? html`<p class="meta">${this.empty}</p>`
            : html`<ul>
                ${mine.map((note) => this.#note(note, now))}
              </ul>`
        }
        <div class="actions">
          <gw-button
            size="xs"
            appearance="outlined"
            variant="neutral"
            icon=${phPlus}
            @click=${(event: Event) => this.#open(event, null)}
            >Add a note</gw-button
          >
        </div>
      </gw-stack>`;
    })}
    ${this.#popoverTemplate()}`;
  }
}

customElements.define("upkeep-notes", UpkeepNotes);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-notes": UpkeepNotes;
  }
}
