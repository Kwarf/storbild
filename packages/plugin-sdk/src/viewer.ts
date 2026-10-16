// Browser-only part of the SDK: base classes for viewer elements (DESIGN.md §6.2).
import type { JsonValue } from "@storbild/core";
import { LitElement, type PropertyDeclarations, type PropertyValues } from "lit";

/** What the compositor gives every viewer element. */
export interface ViewerContext {
  /** The estimated server time, epoch ms. The only clock to use for anything scheduled. */
  serverNow(): number;
  /** The URL of an uploaded asset. */
  assetUrl(assetId: string): string;
}

/**
 * Shared base of scenes and overlays. The compositor sets the properties and calls the
 * lifecycle methods; elements never schedule themselves or implement transitions.
 */
export abstract class StorbildElement<
  Config,
  Settings,
  State,
  PluginState = JsonValue,
> extends LitElement {
  static override properties: PropertyDeclarations = {
    config: { attribute: false },
    settings: { attribute: false },
    state: { attribute: false },
    pluginState: { attribute: false },
    ctx: { attribute: false },
    visible: { attribute: false },
  };

  declare config: Config;
  declare settings: Settings;
  /** This instance's runtime data, written by the plugin's server part, if any. */
  declare state: State | undefined;
  /** The plugin's runtime data shared by all its instances, if any. */
  declare pluginState: PluginState | undefined;
  declare ctx: ViewerContext;
  /**
   * `false` while the element is mounted but fully hidden: prepared before `enter`, under a
   * layer that has faded out or a blackout, or a widget faded out for a reserved slot or stale
   * data. It turns `true` before a fade-in and `false` after a fade-out, so an animated element
   * can stop drawing while nobody sees it. Older hosts leave it `undefined`, so treat anything
   * but `false` as visible.
   */
  declare visible: boolean | undefined;

  /** Preloads what the element needs (images, fonts). Awaited before the element is shown. */
  prepare(): void | Promise<void> {}

  /** The element becomes visible at server time `at`. */
  enter(_at: number): void {}

  /** The element starts leaving at server time `at`. */
  exit(_at: number): void {}

  /** The element is about to be removed; release resources. */
  dispose(): void {}
}

/** Base class for full-screen scenes. Scenes are transparent unless they draw a background. */
export abstract class StorbildScene<
  Config,
  Settings = unknown,
  State = JsonValue,
  PluginState = JsonValue,
> extends StorbildElement<Config, Settings, State, PluginState> {}

/** Fired by an overlay when it becomes stale or fresh again; `detail` is the new `stale`. */
export const STALE_EVENT = "sb-overlay-stale";

/** Timers wait at most this long, so a far-off `staleAt` is checked again later. */
const MAX_WAIT_MS = 60_000;

/**
 * Base class for overlay widgets. Widgets size themselves inside their slot.
 *
 * A widget whose data can go stale (for example a now-playing display that hasn't heard from
 * its source in a while) overrides `staleAt()`. The compositor then fades it out and closes
 * the gap in its slot until it is fresh again.
 */
export abstract class StorbildOverlay<
  Config,
  Settings = unknown,
  State = JsonValue,
  PluginState = JsonValue,
> extends StorbildElement<Config, Settings, State, PluginState> {
  static override properties: PropertyDeclarations = {
    ...StorbildElement.properties,
    stale: { type: Boolean, reflect: true },
  };

  /** Whether the widget's data is stale. Set from `staleAt()`; don't set it yourself. */
  declare stale: boolean;

  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.stale = false;
  }

  /**
   * The server time at which the widget's data becomes stale, or `undefined` if it never does.
   * Checked after every update and again when that time comes. Return a past time (such as 0)
   * when there is no data at all.
   */
  staleAt(): number | undefined {
    return undefined;
  }

  protected override willUpdate(changed: PropertyValues) {
    super.willUpdate(changed);
    const at = this.staleAt();
    const now = this.ctx?.serverNow();
    this.stale = at !== undefined && now !== undefined && now >= at;
  }

  protected override updated(changed: PropertyValues) {
    super.updated(changed);
    if (changed.has("stale")) {
      this.dispatchEvent(
        new CustomEvent<boolean>(STALE_EVENT, {
          detail: this.stale,
          bubbles: true,
          composed: true,
        }),
      );
    }
    clearTimeout(this.#timer);
    const at = this.staleAt();
    const now = this.ctx?.serverNow();
    if (!this.stale && at !== undefined && now !== undefined && this.isConnected) {
      this.#timer = setTimeout(
        () => this.requestUpdate(),
        Math.min(Math.max(at - now, 0), MAX_WAIT_MS),
      );
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    // Re-arms the stale timer after a move, e.g. to another slot.
    if (this.hasUpdated) this.requestUpdate();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.#timer);
  }
}
