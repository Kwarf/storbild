import { z } from "zod";
import { durationMsSchema, epochMsSchema, idSchema } from "./schema/common.ts";
import { instanceBackgroundSchema } from "./schema/instance.ts";

function command<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ type: z.literal(type), payload });
}

// In update payloads, an absent field is left unchanged and `null` clears an optional field.
export const commandSchema = z.discriminatedUnion("type", [
  command(
    "instance.create",
    z.object({
      plugin: z.string().min(1),
      type: z.string().min(1),
      name: z.string().min(1),
      config: z.json(),
      configVersion: z.number().int().nonnegative().optional(),
      background: instanceBackgroundSchema.optional(),
    }),
  ),
  command(
    "instance.update",
    z.object({
      id: idSchema,
      name: z.string().min(1).optional(),
      config: z.json().optional(),
      configVersion: z.number().int().nonnegative().optional(),
      background: instanceBackgroundSchema.nullable().optional(),
    }),
  ),
  command("instance.delete", z.object({ id: idSchema })),
  command(
    "playlist.addItem",
    z.object({
      instanceId: idSchema,
      enabled: z.boolean().optional(),
      durationMs: durationMsSchema.optional(),
      activeFrom: epochMsSchema.optional(),
      activeUntil: epochMsSchema.optional(),
      /** Insert position; appends when absent or past the end. */
      index: z.number().int().nonnegative().optional(),
    }),
  ),
  command(
    "playlist.updateItem",
    z.object({
      id: idSchema,
      instanceId: idSchema.optional(),
      enabled: z.boolean().optional(),
      durationMs: durationMsSchema.nullable().optional(),
      activeFrom: epochMsSchema.nullable().optional(),
      activeUntil: epochMsSchema.nullable().optional(),
    }),
  ),
  command("playlist.removeItem", z.object({ id: idSchema })),
  /** `itemIds` must be a permutation of the current item IDs. */
  command("playlist.reorder", z.object({ itemIds: z.array(idSchema) })),
]);
export type Command = z.infer<typeof commandSchema>;
export type CommandType = Command["type"];

/** The body of `POST /api/commands`. */
export const commandRequestSchema = z.intersection(
  commandSchema,
  z.object({ expectedRevision: z.number().int().nonnegative().optional() }),
);
export type CommandRequest = z.infer<typeof commandRequestSchema>;
