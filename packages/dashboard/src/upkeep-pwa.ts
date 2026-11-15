/**
 * The dashboard's app-level notices and install controls: a banner offering to
 * install it as an app until it's turned down once, a banner for a page the
 * server has moved past, and an Install button for the app bar, which is the
 * only place left to install from once the banner's dismissed.
 */
import "@timmo001/groundwork-ui/define/gw-banner.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import { css, html, LitElement, nothing } from "lit";
import { pwa } from "./pwa.ts";
import { isOutdated, outdatedEvent } from "./update.ts";

const dismissedKey = "upkeep:install-dismissed";

/** Whether the browser has an install prompt to show. */
const canInstall = () => pwa.canInstall() && !pwa.installed();

/** Shows the browser's prompt, and stops offering after it's turned down. */
const install = async () => {
  if ((await pwa.install()) === "dismissed") {
    localStorage.setItem(dismissedKey, new Date().toISOString());
    window.dispatchEvent(new Event("gw-install-change"));
  }
};

/** Redraws its host when the browser offers or withdraws the install prompt. */
const watchInstall = (host: LitElement) => {
  const update = () => host.requestUpdate();

  return {
    connect: () => window.addEventListener("gw-install-change", update),
    disconnect: () => window.removeEventListener("gw-install-change", update),
  };
};

export class UpkeepNotices extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
  `;

  readonly #install = watchInstall(this);

  readonly #onOutdated = () => this.requestUpdate();

  override connectedCallback() {
    super.connectedCallback();
    this.#install.connect();
    window.addEventListener(outdatedEvent, this.#onOutdated);
  }

  override disconnectedCallback() {
    this.#install.disconnect();
    window.removeEventListener(outdatedEvent, this.#onOutdated);
    super.disconnectedCallback();
  }

  readonly #turnDown = () => {
    localStorage.setItem(dismissedKey, new Date().toISOString());
    this.requestUpdate();
  };

  override render() {
    return html`
      <gw-banner tone="warning" urgent ?open=${isOutdated()}>
        <p>Upkeep was updated on the server. Reload to use the new version.</p>
        <gw-button slot="actions" size="small" @click=${() => location.reload()}
          >Reload</gw-button
        >
      </gw-banner>
      <gw-banner
        ?open=${canInstall() && localStorage.getItem(dismissedKey) === null}
      >
        <p>Install Upkeep as an app, in its own window.</p>
        <gw-button slot="actions" size="small" @click=${() => void install()}
          >Install</gw-button
        >
        <gw-button
          slot="actions"
          size="small"
          appearance="plain"
          variant="neutral"
          @click=${this.#turnDown}
          >Not now</gw-button
        >
      </gw-banner>
    `;
  }
}

export class UpkeepInstall extends LitElement {
  readonly #install = watchInstall(this);

  override connectedCallback() {
    super.connectedCallback();
    this.#install.connect();
  }

  override disconnectedCallback() {
    this.#install.disconnect();
    super.disconnectedCallback();
  }

  override render() {
    return canInstall()
      ? html`<gw-button
          appearance="outlined"
          variant="neutral"
          @click=${() => void install()}
          >Install app</gw-button
        >`
      : nothing;
  }
}

customElements.define("upkeep-notices", UpkeepNotices);

customElements.define("upkeep-install", UpkeepInstall);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-notices": UpkeepNotices;
    "upkeep-install": UpkeepInstall;
  }
}
