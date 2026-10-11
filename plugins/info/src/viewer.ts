import type { PluginConfig, PluginSettings } from "@storbild/plugin-sdk";
import { StorbildOverlay } from "@storbild/plugin-sdk/viewer";
import { css, html } from "lit";
import { formatTime, untilNextTick } from "./clock.ts";
import type plugin from "./plugin.ts";

type Config = PluginConfig<typeof plugin, "clock">;
type Settings = PluginSettings<typeof plugin>;

/** The current server time, redrawn when the shown minute or second changes. */
export class ClockOverlay extends StorbildOverlay<Config, Settings> {
  static override styles = css`
    :host {
      display: block;
      padding: 12px 28px;
      border-radius: 8px;
      background: var(--sb-color-surface, #15171c);
      color: var(--sb-color-text, #fff);
      font-family: var(--sb-font-heading, sans-serif);
      font-size: 56px;
      font-variant-numeric: tabular-nums;
      line-height: 1.1;
    }
  `;

  #timer: ReturnType<typeof setTimeout> | undefined;

  override render() {
    const now = this.ctx.serverNow();
    const seconds = this.config.seconds;
    clearTimeout(this.#timer);
    if (this.isConnected) {
      this.#timer = setTimeout(() => this.requestUpdate(), untilNextTick(now, seconds) + 5);
    }
    return html`${formatTime(now, { seconds, timeZone: this.settings.timeZone })}`;
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) this.requestUpdate();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.#timer);
  }
}

customElements.define("sb-info-clock", ClockOverlay);
