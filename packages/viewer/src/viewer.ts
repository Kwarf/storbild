import type { ShowState } from "@storbild/core";
import type { ViewerContext } from "@storbild/plugin-sdk/viewer";
import { html, LitElement, type PropertyDeclarations } from "lit";
import { ClockSync } from "./clock.ts";
import { hasStaleModules } from "./modules.ts";
import { SyncClient, type Timers } from "./sync.ts";
import "./compositor.ts";
import "./stage.ts";

const timers: Timers = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number | undefined),
};

/** Monotonic, so local NTP adjustments don't move the estimated server clock. */
const localNow = () => performance.timeOrigin + performance.now();

const noStore = (url: string) => fetch(url, { cache: "no-store" });

/**
 * The screen: follows the server's state over SSE and renders it on a scaled stage. It
 * resyncs the clock after reconnects and when the page becomes visible again.
 */
export class Viewer extends LitElement {
  static override properties: PropertyDeclarations = {
    state: { state: true },
  };

  declare state: ShowState | undefined;

  readonly clock = new ClockSync({ url: "/time", fetch: noStore, localNow, timers });
  readonly sync = new SyncClient({
    url: "/events",
    probeUrl: "/time",
    openEventSource: (url) => new EventSource(url),
    fetch: noStore,
    timers,
    reload: () => location.reload(),
    onState: (state) => {
      if (hasStaleModules(state)) location.reload();
      else this.state = state;
    },
    onConnect: () => void this.clock.sync(),
  });
  readonly ctx: ViewerContext = {
    serverNow: this.clock.serverNow,
    assetUrl: (assetId) => `/assets/${encodeURIComponent(assetId)}`,
  };

  readonly #onVisibility = () => {
    if (document.visibilityState !== "visible") return;
    void this.clock.sync();
    this.requestUpdate();
  };

  override connectedCallback() {
    super.connectedCallback();
    this.clock.start();
    this.sync.start();
    document.addEventListener("visibilitychange", this.#onVisibility);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.sync.stop();
    this.clock.stop();
    document.removeEventListener("visibilitychange", this.#onVisibility);
  }

  // Light DOM, so the page's base styles size the stage.
  protected override createRenderRoot() {
    return this;
  }

  override render() {
    return html`<sb-stage><sb-compositor .state=${this.state} .ctx=${this.ctx}></sb-compositor></sb-stage>`;
  }
}

customElements.define("sb-viewer", Viewer);
