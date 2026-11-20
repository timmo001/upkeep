/**
 * `upkeep-backups`: the Backups section of the Jobs page. Makes a backup of
 * the server's store, lists the ones kept on the server to download, delete
 * or restore, and restores a file from this device. A restore asks first,
 * then waits for the server to start again on it and loads the page again.
 */
import "@timmo001/groundwork-ui/define/gw-popover.ts";
import { GwPopover } from "@timmo001/groundwork-ui/gw-popover.ts";
import type { Api } from "@upkeep/api";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { AtomController, registry } from "./AtomController.ts";
import {
  phArchive,
  phArrowCounterClockwise,
  phDownloadSimple,
  phTrash,
  phUploadSimple,
} from "./icons.ts";
import { shared, time, view } from "./ui.ts";
import {
  type BackupAction,
  backupAction,
  backups,
  serverBack,
  token,
  uploadBackup,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-alert.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/layout.ts";

/** A size in words, such as `12 KB` or `3.4 MB`. */
const sizeText = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.ceil(bytes / 1024))} KB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

/** A backup to restore: one kept on the server, or a file from this device. */
type Chosen = { readonly name: string } | { readonly file: File };

export class UpkeepBackups extends LitElement {
  static override styles = [
    shared,
    css`
      ul {
        display: grid;
        gap: var(--gw-space-2);
        margin: 0;
        padding: 0;
        list-style: none;
      }

      li {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: var(--gw-space-2);
        align-items: center;
      }

      .name {
        margin: 0;
        overflow-wrap: anywhere;
      }

      .meta {
        margin: 0;
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }

      .row-actions {
        display: flex;
        gap: var(--gw-space-1);
      }

      input[type="file"] {
        display: none;
      }
    `,
  ];

  readonly #backups = new AtomController(this, () => backups);

  readonly #action = new AtomController(this, () => backupAction);

  #popover: GwPopover | undefined;

  #file: HTMLInputElement | undefined;

  /** The backup the confirmation is about. */
  #chosen: Chosen | undefined;

  /** What the last upload or restore said, while one is under way. */
  #progress = "";

  #restoring = false;

  #run(action: BackupAction) {
    registry.set(backupAction, action);
  }

  #ask(anchor: Element | undefined, chosen: Chosen) {
    this.#chosen = chosen;

    if (this.#popover !== undefined) {
      this.#popover.heading = `Restore ${"name" in chosen ? chosen.name : chosen.file.name}?`;
    }

    this.#popover?.show(anchor);
  }

  /** Restore the chosen backup, as the confirmation closed with Restore. */
  #confirmed() {
    const chosen = this.#chosen;

    this.#chosen = undefined;

    if (this.#popover?.returnValue !== "restore" || chosen === undefined)
      return;

    if ("name" in chosen) {
      this.#run({ kind: "restore", name: chosen.name });

      return;
    }

    this.#restoring = true;
    this.#say("Sending the backup…");

    void uploadBackup(chosen.file, registry.get(token), (sent) =>
      this.#say(
        `Sending the backup: ${sizeText(sent)} of ${sizeText(chosen.file.size)}`,
      ),
    ).then((failure) => {
      if (failure === undefined) return this.#followRestart();

      this.#restoring = false;
      this.#say(failure);
    });
  }

  #say(message: string) {
    this.#progress = message;
    this.requestUpdate();
  }

  /** Wait for the server to start again on the restored store, then reload. */
  async #followRestart() {
    this.#restoring = true;
    this.#say("The server is starting again on the backup…");
    await serverBack();
    location.reload();
  }

  override updated() {
    const outcome = this.#action.value;

    if (
      AsyncResult.isSuccess(outcome) &&
      outcome.value.restarting &&
      !this.#restoring
    ) {
      void this.#followRestart();
    }
  }

  #outcome() {
    if (this.#progress !== "") {
      return html`<gw-alert tone=${this.#restoring ? "neutral" : "danger"}
        >${this.#progress}</gw-alert
      >`;
    }

    const outcome = this.#action.value;

    if (AsyncResult.isFailure(outcome)) {
      return html`<gw-alert tone="danger"
        >Couldn't reach the server. Try again in a moment.</gw-alert
      >`;
    }

    if (!AsyncResult.isSuccess(outcome)) return nothing;

    return html`<gw-alert tone=${outcome.value.tone}
      >${outcome.value.message}</gw-alert
    >`;
  }

  #backup(backup: Api.BackupFile) {
    const button = (
      label: string,
      icon: string,
      click: (event: Event) => void,
    ) =>
      html`<gw-button
        size="xs"
        appearance="plain"
        variant="neutral"
        labels="hide"
        icon=${icon}
        ?disabled=${this.#restoring}
        @click=${click}
        >${label}</gw-button
      >`;

    return html`<li>
      <div>
        <p class="name">${backup.name}</p>
        <p class="meta">Made ${time(backup.at)}, ${sizeText(backup.bytes)}</p>
      </div>
      <div class="row-actions">
        ${button("Download", phDownloadSimple, () =>
          this.#run({ kind: "download", name: backup.name }),
        )}
        ${button("Restore", phArrowCounterClockwise, (event) =>
          this.#ask(
            event.currentTarget instanceof Element
              ? event.currentTarget
              : undefined,
            { name: backup.name },
          ),
        )}
        ${button("Delete", phTrash, () =>
          this.#run({ kind: "remove", name: backup.name }),
        )}
      </div>
    </li>`;
  }

  #picked() {
    const file = this.#file?.files?.[0];

    if (this.#file !== undefined) this.#file.value = "";

    if (file !== undefined) this.#ask(this.#fromFile, { file });
  }

  #fromFile: Element | undefined;

  override render() {
    const making = AsyncResult.isWaiting(this.#action.value) || this.#restoring;

    return html`<gw-stack gap="s">
        <p class="meta">
          A backup is the server's whole store: runs, the inbox, attention,
          notes, repositories and the admin and worker tokens. Settings in the
          environment or the app's options aren't in it. Backups are kept in the
          backups folder beside the store, so download one to keep it somewhere
          else too.
        </p>
        <div class="actions">
          <gw-button
            size="small"
            appearance="outlined"
            variant="neutral"
            icon=${phArchive}
            ?loading=${making}
            ?disabled=${making}
            @click=${() => this.#run({ kind: "make" })}
            >Make a backup</gw-button
          >
          <gw-button
            size="small"
            appearance="outlined"
            variant="neutral"
            icon=${phUploadSimple}
            ?disabled=${making}
            ${ref((element) => {
              this.#fromFile = element;
            })}
            @click=${() => this.#file?.click()}
            >Restore from a file</gw-button
          >
          <input
            type="file"
            accept=".upkeep-backup"
            ${ref((element) => {
              this.#file =
                element instanceof HTMLInputElement ? element : undefined;
            })}
            @change=${() => this.#picked()}
          />
        </div>
        ${this.#outcome()}
        ${view(this.#backups.value, (all) =>
          all.length === 0
            ? html`<p class="meta">No backups are kept on the server yet.</p>`
            : html`<ul>
                ${all.map((backup) => this.#backup(backup))}
              </ul>`,
        )}
      </gw-stack>
      <gw-popover
        confirm
        ${ref((element) => {
          this.#popover = element instanceof GwPopover ? element : undefined;
        })}
        @close=${() => this.#confirmed()}
      >
        <p>
          Everything the server keeps becomes the backup's, and the server
          starts again on it. The store it replaces is kept beside it as
          server.db.before-restore.
        </p>
        <gw-button
          slot="actions"
          size="small"
          appearance="plain"
          variant="neutral"
          value="cancel"
          >Cancel</gw-button
        >
        <gw-button
          slot="actions"
          size="small"
          variant="danger"
          value="restore"
          icon=${phArrowCounterClockwise}
          >Restore</gw-button
        >
      </gw-popover>`;
  }
}

customElements.define("upkeep-backups", UpkeepBackups);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-backups": UpkeepBackups;
  }
}
