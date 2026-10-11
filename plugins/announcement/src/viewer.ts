import type { PluginConfig } from "@storbild/plugin-sdk";
import { StorbildScene } from "@storbild/plugin-sdk/viewer";
import { css, html, type PropertyValues } from "lit";
import type plugin from "./plugin.ts";

type Config = PluginConfig<typeof plugin, "announcement">;

/** The largest and smallest message size, in px on the 1920×1080 canvas. */
const MAX_FONT = 96;
const MIN_FONT = 28;

/**
 * A big message on an opaque panel, so it reads over a scene left visible or dimmed beneath an
 * interrupt (ADR 0008). The text shrinks until it fits the panel.
 */
export class AnnouncementScene extends StorbildScene<Config> {
  static override styles = css`
    :host {
      display: grid;
      place-items: center;
      box-sizing: border-box;
      height: 100%;
      padding: var(--sb-safe-area, 96px);
      color: var(--sb-color-text, #fff);
      font-family: var(--sb-font-body, sans-serif);
    }
    .panel {
      box-sizing: border-box;
      display: grid;
      gap: 0.4em;
      width: 100%;
      max-height: 100%;
      padding: 64px 80px;
      overflow: hidden;
      background: var(--sb-color-surface, #15171c);
      border-radius: 12px;
      border-top: 0 solid var(--sb-color-accent, #e8a33d);
    }
    .panel.urgent {
      border-top-width: 24px;
    }
    h1 {
      margin: 0;
      font-family: var(--sb-font-heading, sans-serif);
      font-size: 0.75em;
      color: var(--sb-color-accent, #e8a33d);
    }
    p {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.2;
    }
  `;

  protected override updated(changes: PropertyValues<this>) {
    if (changes.has("config")) this.#fit();
  }

  override async prepare() {
    await this.updateComplete;
    this.#fit();
  }

  /** Steps the font size down until the panel no longer overflows. */
  #fit() {
    const panel = this.renderRoot.querySelector<HTMLElement>(".panel");
    if (!panel) return;
    let size = MAX_FONT;
    panel.style.fontSize = `${size}px`;
    while (size > MIN_FONT && panel.scrollHeight > panel.clientHeight + 1) {
      size -= 4;
      panel.style.fontSize = `${size}px`;
    }
  }

  override render() {
    const { title, message, tone } = this.config;
    return html`<div class="panel ${tone === "urgent" ? "urgent" : ""}" data-tone=${tone}>
      ${title ? html`<h1>${title}</h1>` : null}
      <p>${message}</p>
    </div>`;
  }
}

customElements.define("sb-announcement", AnnouncementScene);
