// Browser-only part of the SDK: base classes for viewer elements (DESIGN.md §6.2).
import type { JsonValue } from "@storbild/core";
import { LitElement, type PropertyDeclarations } from "lit";

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
export abstract class StorbildElement<Config, Settings, State> extends LitElement {
  static override properties: PropertyDeclarations = {
    config: { attribute: false },
    settings: { attribute: false },
    state: { attribute: false },
    ctx: { attribute: false },
  };

  declare config: Config;
  declare settings: Settings;
  /** Runtime data written by the plugin's server part, if any. */
  declare state: State | undefined;
  declare ctx: ViewerContext;

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
> extends StorbildElement<Config, Settings, State> {}

/** Base class for overlay widgets. Widgets size themselves inside their slot. */
export abstract class StorbildOverlay<
  Config,
  Settings = unknown,
  State = JsonValue,
> extends StorbildElement<Config, Settings, State> {}
