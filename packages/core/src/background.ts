import type { InstanceBackground } from "./schema/instance.ts";
import type { ShowState } from "./schema/state.ts";

/**
 * What a scene shows behind itself (DESIGN.md §4.6, ADR 0014): its instance's `background`
 * when set, else `none` for a type that draws its own (`background: "own"`), else the theme's.
 * With anything but `theme`, the compositor fades the theme background out while it is on air.
 */
export function sceneBackground(state: ShowState, instanceId: string): InstanceBackground {
  const instance = state.instances[instanceId];
  if (!instance) return "theme";
  if (instance.background !== undefined) return instance.background;
  const type = state.plugins[instance.plugin]?.types[instance.type];
  return type?.background === "own" ? "none" : "theme";
}
