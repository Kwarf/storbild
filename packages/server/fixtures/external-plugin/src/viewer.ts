import type { PluginConfig, PluginSettings } from "@storbild/plugin-sdk";
import { StorbildOverlay } from "@storbild/plugin-sdk/viewer";
import { html } from "lit";
import type plugin from "./plugin.ts";

type Config = PluginConfig<typeof plugin, "banner">;
type Settings = PluginSettings<typeof plugin>;

class Banner extends StorbildOverlay<Config, Settings> {
  override render() {
    return html`${this.settings.greeting}: ${this.config.text.repeat(this.config.repeat)}`;
  }
}

customElements.define("ext-banner", Banner);
