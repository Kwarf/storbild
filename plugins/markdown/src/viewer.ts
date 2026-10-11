import type { PluginConfig, PluginSettings } from "@storbild/plugin-sdk";
import { StorbildScene } from "@storbild/plugin-sdk/viewer";
import { css, html } from "lit";
import type plugin from "./plugin.ts";

type Config = PluginConfig<typeof plugin, "text">;
type Settings = PluginSettings<typeof plugin>;

/** Title and body text. Renders the body as plain text until markdown support (M9). */
export class MarkdownScene extends StorbildScene<Config, Settings> {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      justify-content: center;
      box-sizing: border-box;
      height: 100%;
      padding: var(--sb-safe-area, 96px);
      color: var(--sb-color-text, #fff);
      font-family: var(--sb-font-body, sans-serif);
    }
    h1 {
      margin: 0 0 0.5em;
      font-family: var(--sb-font-heading, sans-serif);
      font-size: calc(96px * var(--scale));
    }
    p {
      margin: 0;
      white-space: pre-wrap;
      font-size: calc(48px * var(--scale));
    }
  `;

  override render() {
    return html`
      <div style="--scale: ${this.settings.fontScale}">
        ${this.config.title ? html`<h1>${this.config.title}</h1>` : null}
        <p>${this.config.content}</p>
      </div>
    `;
  }
}

customElements.define("sb-markdown-scene", MarkdownScene);
