import type { PluginConfig } from "@storbild/plugin-sdk";
import { StorbildScene } from "@storbild/plugin-sdk/viewer";
import { css, html } from "lit";
import type plugin from "./plugin.ts";

type Config = PluginConfig<typeof plugin, "greeting">;

/** A message in the theme's type, with the time of day below it. */
export class GreetingScene extends StorbildScene<Config> {
  // The theme reaches plugins only as CSS variables; give each a fallback.
  static override styles = css`
    :host {
      display: grid;
      place-content: center;
      gap: 48px;
      height: 100%;
      box-sizing: border-box;
      padding: var(--sb-safe-area, 96px);
      text-align: center;
      color: var(--sb-color-text, #fff);
      font-family: var(--sb-font-body, sans-serif);
    }
    p {
      margin: 0;
      font-family: var(--sb-font-heading, sans-serif);
      font-size: 120px;
      line-height: 1.1;
      white-space: pre-wrap;
    }
    time {
      font-size: 64px;
      font-variant-numeric: tabular-nums;
      color: var(--sb-color-accent, #e8a33d);
    }
  `;

  #timer: ReturnType<typeof setTimeout> | undefined;

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.#timer);
  }

  override render() {
    const { message, showClock } = this.config;
    clearTimeout(this.#timer);
    if (!showClock) return html`<p>${message}</p>`;
    // Anything shown on the screen uses the server's clock, never Date.now().
    const now = this.ctx.serverNow();
    this.#timer = setTimeout(() => this.requestUpdate(), 1000 - (now % 1000));
    const time = new Date(now).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return html`<p>${message}</p>
      <time>${time}</time>`;
  }
}

customElements.define("hello-greeting", GreetingScene);
