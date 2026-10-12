import { referencedAssetIds, type ShowState } from "@storbild/core";
import type { ViewerContext } from "@storbild/plugin-sdk/viewer";
import { html, LitElement, type PropertyDeclarations } from "lit";
import { ClockSync } from "./clock.ts";
import { LastState, type StorageLike, type StoredShow } from "./last-state.ts";
import { hasStaleModules } from "./modules.ts";
import { OfflineTracker, offlineLabel } from "./offline-indicator.ts";
import { cacheAssets } from "./service-worker.ts";
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

/** How long a starting screen waits for the server before showing its stored state. */
const STORED_STATE_AFTER_MS = 3_000;
/** How long the asset list settles before the service worker is asked to cache it. */
const CACHE_ASSETS_AFTER_MS = 2_000;

/** `localStorage`, or undefined where reading the property itself throws. */
function localStorageOrNone(): StorageLike | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The screen: follows the server's state over SSE and renders it on a scaled stage. It
 * resyncs the clock after reconnects and when the page becomes visible again.
 *
 * For outages (ADR 0019) it keeps its last state and clock offset, starts from them when the
 * server doesn't answer within a few seconds, asks the service worker to cache the assets the
 * show uses, and shows when it has lost the server.
 */
export class Viewer extends LitElement {
  static override properties: PropertyDeclarations = {
    state: { state: true },
    offline: { state: true },
  };

  declare state: ShowState | undefined;
  declare offline: string | undefined;

  readonly clock = new ClockSync({ url: "/time", fetch: noStore, localNow, timers });
  readonly sync = new SyncClient({
    url: "/events",
    probeUrl: "/time",
    openEventSource: (url) => new EventSource(url),
    fetch: noStore,
    timers,
    reload: () => location.reload(),
    onState: (state) => this.#onState(state),
    onConnect: () => {
      void this.clock.sync();
      this.#checkContact();
    },
    now: () => this.clock.serverNow(),
  });
  readonly ctx: ViewerContext = {
    serverNow: this.clock.serverNow,
    assetUrl: (assetId) => `/assets/${encodeURIComponent(assetId)}`,
  };

  readonly #last = new LastState({ storage: localStorageOrNone(), timers, now: localNow });
  readonly #tracker = new OfflineTracker();
  #stored: StoredShow | undefined;
  #storedTimer: number | undefined;
  #contactTimer: number | undefined;
  #assetsTimer: number | undefined;

  readonly #onVisibility = () => {
    if (document.visibilityState !== "visible") return;
    void this.clock.sync();
    this.requestUpdate();
  };

  readonly #onPageHide = () => this.#last.flush();

  #onState(state: ShowState) {
    if (hasStaleModules(state)) {
      location.reload();
      return;
    }
    window.clearTimeout(this.#storedTimer);
    this.state = state;
    this.#last.save({ state, offsetMs: this.clock.offset, receivedAt: this.clock.serverNow() });
    window.clearTimeout(this.#assetsTimer);
    this.#assetsTimer = window.setTimeout(
      () => cacheAssets([...referencedAssetIds(state)].map((id) => this.ctx.assetUrl(id))),
      CACHE_ASSETS_AFTER_MS,
    );
    this.#checkContact();
  }

  /** Starts from the stored state when the server hasn't sent one in time. */
  #useStored() {
    const stored = this.#stored;
    if (this.state || !stored) return;
    this.state = stored.state;
    this.#tracker.startedOffline(this.clock.serverNow());
    this.#checkContact();
  }

  /** Shows or hides the offline indicator. */
  #checkContact() {
    const lastMessageAt = this.sync.lastMessageAt ?? this.#stored?.receivedAt;
    const offline = this.#tracker.update({
      connected: this.sync.connected,
      lastMessageAt,
      now: this.clock.serverNow(),
    });
    this.offline = offline ? offlineLabel(lastMessageAt) : undefined;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.#stored = this.#last.load();
    if (this.#stored) {
      this.clock.seed(this.#stored.offsetMs);
      this.#storedTimer = window.setTimeout(() => this.#useStored(), STORED_STATE_AFTER_MS);
    }
    this.clock.start();
    this.sync.start();
    this.#contactTimer = window.setInterval(() => this.#checkContact(), 1_000);
    document.addEventListener("visibilitychange", this.#onVisibility);
    window.addEventListener("pagehide", this.#onPageHide);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.sync.stop();
    this.clock.stop();
    this.#last.flush();
    window.clearTimeout(this.#storedTimer);
    window.clearTimeout(this.#assetsTimer);
    window.clearInterval(this.#contactTimer);
    document.removeEventListener("visibilitychange", this.#onVisibility);
    window.removeEventListener("pagehide", this.#onPageHide);
  }

  // Light DOM, so the page's base styles size the stage.
  protected override createRenderRoot() {
    return this;
  }

  override render() {
    return html`<sb-stage>
      <sb-compositor .state=${this.state} .ctx=${this.ctx} .offline=${this.offline}></sb-compositor>
    </sb-stage>`;
  }
}

customElements.define("sb-viewer", Viewer);
