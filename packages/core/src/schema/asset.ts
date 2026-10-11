import { z } from "zod";
import { epochMsSchema } from "./common.ts";

/** An asset's ID: the lowercase hex SHA-256 of its content. */
export const assetIdSchema = z.string().regex(/^[0-9a-f]{64}$/, "expected a SHA-256 hex digest");

/** Metadata for an uploaded file (DESIGN.md §4.7, ADR 0011). The file is stored by its ID. */
export const assetMetaSchema = z.object({
  id: assetIdSchema,
  name: z.string(),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** Whether a thumbnail is stored, served to the admin at `/assets/<id>/thumbnail`. */
  thumbnail: z.boolean().optional(),
  createdAt: epochMsSchema,
});
export type AssetMeta = z.infer<typeof assetMetaSchema>;
