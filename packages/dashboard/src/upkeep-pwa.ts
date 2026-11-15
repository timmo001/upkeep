/**
 * The dashboard's app-level notices and install controls: groundwork's banner
 * offering to install it as an app until it's turned down once, a banner for
 * a page the server has moved past, and an Install button for the app bar,
 * which is the only place left to install from once the banner's dismissed.
 */
import "@timmo001/groundwork-ui/define/gw-banner.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/gw-install-banner.ts";
import { css, html, LitElement, nothing } from "lit";
import { pwa } from "./pwa.ts";
import { update } from "./update.ts";

/** Redraws its host when `event` fires on the window. */
const watchWindow = (host: LitElement, event: string) => {
  const redraw = () => host.requestUpdate();

  return {
    connect: () => window.addEventListener(event, redraw),
    disconnect: () => window.removeEventListener(event, redraw),
  };
};

export class UpkeepNotices extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
  `;

  readonly #stale = watchWindow(this, "gw-version-stale");

  override connectedCallback() {
    super.connectedCallback();
    this.#stale.connect();
  }

  override disconnectedCallback() {
    this.#stale.disconnect();
    super.disconnectedCallback();
  }

  override render() {
    return html`
      <gw-banner tone="warning" urgent ?open=${update.stale()}>
        <p>Upkeep was updated on the server. Reload to use the new version.</p>
        <gw-button slot="actions" size="small" @click=${update.reload}
          >Reload</gw-button
        >
      </gw-banner>
      <gw-install-banner
        storage-key="upkeep:install-dismissed"
        message="Install Upkeep as an app, in its own window."
        .pwa=${pwa}
      ></gw-install-banner>
    `;
  }
}

export class UpkeepInstall extends LitElement {
  readonly #install = watchWindow(this, "gw-install-change");

  override connectedCallback() {
    super.connectedCallback();
    this.#install.connect();
  }

  override disconnectedCallback() {
    this.#install.disconnect();
    super.disconnectedCallback();
  }

  override render() {
    return pwa.canInstall() && !pwa.installed()
      ? html`<gw-button
          appearance="outlined"
          variant="neutral"
          @click=${() => void pwa.install()}
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
