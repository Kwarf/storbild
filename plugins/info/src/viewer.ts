import type { PluginConfig, PluginSettings } from "@storbild/plugin-sdk";
import { StorbildOverlay } from "@storbild/plugin-sdk/viewer";
import { css, html } from "lit";
import { formatTime, untilNextTick } from "./clock.ts";
import type plugin from "./plugin.ts";
import { qrPath, wifiPayload } from "./wifi.ts";

type Config = PluginConfig<typeof plugin, "clock">;
type WifiConfig = PluginConfig<typeof plugin, "wifi">;
type Settings = PluginSettings<typeof plugin>;

/** The current server time, redrawn when the shown minute or second changes. */
export class ClockOverlay extends StorbildOverlay<Config, Settings> {
  static override styles = css`
    :host {
      display: block;
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

/**
 * The Wi-Fi network's name and password, with a QR code that joins it. The code is black on
 * white whatever the theme, because scanners expect dark modules on a light ground (ADR 0015).
 */
export class WifiOverlay extends StorbildOverlay<WifiConfig, Settings> {
  static override styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 24px;
      font-family: var(--sb-font-body, sans-serif);
    }
    svg {
      flex: none;
      width: 200px;
      height: 200px;
      border-radius: 4px;
      background: #fff;
    }
    .text {
      display: grid;
      gap: 4px;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .label,
    .key {
      font-size: 22px;
      color: var(--sb-color-muted, #9aa0aa);
    }
    .ssid {
      font-family: var(--sb-font-heading, sans-serif);
      font-size: 40px;
      line-height: 1.1;
    }
    .password {
      font-family: var(--sb-font-mono, monospace);
      font-size: 32px;
    }
  `;

  override render() {
    const { label, ssid, password, security, showPassword } = this.config;
    const { size, d } = qrPath(wifiPayload(this.config));
    const shownPassword = showPassword && security !== "none" && password;
    return html`<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code to join ${ssid}">
        <path fill="#000" d=${d}></path>
      </svg>
      <div class="text">
        ${label ? html`<div class="label">${label}</div>` : null}
        <div class="key">Network</div>
        <div class="ssid">${ssid}</div>
        ${
          shownPassword
            ? html`<div class="key">Password</div>
                <div class="password">${password}</div>`
            : null
        }
      </div>`;
  }
}

customElements.define("sb-info-clock", ClockOverlay);
customElements.define("sb-info-wifi", WifiOverlay);
