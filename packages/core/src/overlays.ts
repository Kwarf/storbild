import { type OverlayPlacement, type OverlaySlot, overlaySlotSchema } from "./schema/overlay.ts";
import type { ShowState } from "./schema/state.ts";
import type { Timeline } from "./schema/timeline.ts";

/**
 * The slots whose widgets fade out under a timeline: those the scene on air or the interrupt
 * reserves, or every slot when either hides overlays (ADR 0012).
 */
export function reservedSlots(state: ShowState, timeline: Timeline): ReadonlySet<OverlaySlot> {
  const slots = new Set<OverlaySlot>();
  for (const live of [timeline.main, timeline.interrupt]) {
    const instance = live && state.instances[live.instanceId];
    const type = instance && state.plugins[instance.plugin]?.types[instance.type];
    if (!type) continue;
    if (type.hideOverlays) return new Set(overlaySlotSchema.options);
    for (const slot of type.reserveSlots ?? []) slots.add(slot);
  }
  return slots;
}

/** The placements in one slot, in stack order. */
export function slotStack(state: ShowState, slot: OverlaySlot): OverlayPlacement[] {
  return state.overlays.filter((p) => p.slot === slot).toSorted((a, b) => a.order - b.order);
}
