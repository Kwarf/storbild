import { z } from "zod";
import { epochMsSchema } from "./common.ts";

/** Metadata for an uploaded file. The ID is the content hash. The asset store arrives in M6. */
export const assetMetaSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  createdAt: epochMsSchema,
});
export type AssetMeta = z.infer<typeof assetMetaSchema>;
