// The viewer as a library: the compositor and sync client, for the viewer page and the admin
// preview (M5). Importing it defines the custom elements but starts nothing.

export { BackgroundLayer } from "./background-layer.ts";
export { ClockSync, type ClockSyncOptions } from "./clock.ts";
export { Compositor } from "./compositor.ts";
export { hasStaleModules } from "./modules.ts";
export { OverlayLayer, type OverlayLayerOptions } from "./overlay-layer.ts";
export { SceneLayer, type SceneLayerOptions, TRANSITION_MS } from "./scene-layer.ts";
export { STAGE_HEIGHT, STAGE_WIDTH, Stage } from "./stage.ts";
export { type EventSourceLike, SyncClient, type SyncClientOptions, type Timers } from "./sync.ts";
export {
  DEFAULT_GAP,
  DEFAULT_SAFE_AREA,
  FONT_TIMEOUT_MS,
  fontStack,
  themeVariables,
} from "./theme.ts";
