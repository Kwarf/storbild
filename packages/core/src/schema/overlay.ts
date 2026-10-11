import { z } from "zod";
import { idSchema } from "./common.ts";

export const overlaySlotSchema = z.enum([
  "top-left",
  "top",
  "top-right",
  "left",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
  "top-bar",
  "bottom-bar",
]);
export type OverlaySlot = z.infer<typeof overlaySlotSchema>;

export const overlayPlacementSchema = z.object({
  /** An instance of an overlay type. Each instance is placed at most once. */
  instanceId: idSchema,
  slot: overlaySlotSchema,
  /** Position within the slot's stack. */
  order: z.number().int(),
  visible: z.boolean(),
});
export type OverlayPlacement = z.infer<typeof overlayPlacementSchema>;
