/**
 * `upkeep-sign-in`: asks for an admin token when the server refuses a request
 * without one, and keeps it in the browser.
 */
import { css, html, LitElement } from "lit";
import { registry } from "./AtomController.ts";
import { phSignIn } from "./icons.ts";
import { token } from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/gw-input.ts";

export class UpkeepSignIn extends LitElement {
  static override styles = css`
    form {
      display: grid;
      gap: var(--gw-space-3);
      max-width: 28rem;
      margin: 3rem auto;
    }

    p {
      margin: 0;
      color: var(--gw-color-text-secondary);
    }

    code {
      font-family: var(--gw-font-mono);
    }

    gw-button {
      justify-self: start;
    }
  `;

  override render() {
    return html`
      <form @submit=${this.#submit}>
        <h1>Sign in</h1>
        <gw-input
          label="Admin token"
          name="token"
          type="password"
          autocomplete="current-password"
          monospace
          reveal
          required
        ></gw-input>
        <p>Make one with <code>upkeep admins add &lt;name&gt;</code>.</p>
        <gw-button type="submit" icon=${phSignIn}>Sign in</gw-button>
      </form>
    `;
  }

  readonly #submit = (event: SubmitEvent) => {
    event.preventDefault();

    if (!(event.currentTarget instanceof HTMLFormElement)) return;

    const input = event.currentTarget.elements.namedItem("token");

    if (input instanceof HTMLInputElement && input.value.trim() !== "") {
      registry.set(token, input.value.trim());
    }
  };
}

customElements.define("upkeep-sign-in", UpkeepSignIn);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-sign-in": UpkeepSignIn;
  }
}
