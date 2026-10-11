import type { PluginConfig } from "@storbild/plugin-sdk";
import { StorbildOverlay, StorbildScene } from "@storbild/plugin-sdk/viewer";
import { css, html } from "lit";
import type plugin from "./plugin.ts";

type Config = PluginConfig<typeof plugin, "scene">;

/** Lifecycle events, in order, for the tests to read. */
const events: string[] = [];
(window as unknown as { __probe: string[] }).__probe = events;

class ProbeScene extends StorbildScene<Config> {
  override async prepare() {
    events.push(`prepare ${this.config.label}`);
    await new Promise((resolve) => setTimeout(resolve, this.config.prepareMs));
    if (this.config.failPrepare) throw new Error(`prepare failed for ${this.config.label}`);
  }

  override enter() {
    events.push(`enter ${this.config.label}`);
  }

  override exit() {
    events.push(`exit ${this.config.label}`);
  }

  override dispose() {
    events.push(`dispose ${this.config.label}`);
  }

  override render() {
    return html`<p class="probe">${this.config.label}</p>`;
  }
}

customElements.define("probe-scene", ProbeScene);

class ProbeCard extends StorbildScene<PluginConfig<typeof plugin, "card">> {
  override render() {
    return html`<p class="probe-card">${this.config.text}</p>`;
  }
}

customElements.define("probe-card", ProbeCard);

class ProbeWidget extends StorbildOverlay<PluginConfig<typeof plugin, "widget">> {
  static override styles = css`
    :host {
      display: block;
      background: #08f;
    }
  `;

  override staleAt() {
    return this.config.staleAt;
  }

  override render() {
    const { width, height, label } = this.config;
    return html`<p class="probe-widget" style="margin: 0; width: ${width}px; height: ${height}px">
      ${label}
    </p>`;
  }
}

customElements.define("probe-widget", ProbeWidget);

class ProbeCorner extends StorbildScene<PluginConfig<typeof plugin, "corner">> {
  override render() {
    return html`<p class="probe-corner">${this.config.label}</p>`;
  }
}

customElements.define("probe-corner", ProbeCorner);
