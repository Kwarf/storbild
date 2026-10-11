import { z } from "zod";
import { durationMsSchema, epochMsSchema, idSchema } from "./schema/common.ts";
import { instanceBackgroundSchema } from "./schema/instance.ts";
import { interruptBelowSchema } from "./schema/timeline.ts";

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
  /** Replaces the plugin's settings whole; they are validated by its settings schema. */
  command("plugin.updateSettings", z.object({ plugin: z.string().min(1), settings: z.json() })),
  // Live control (ADR 0006). Without `durationMs`, a take or interrupt holds until cleared.
  command("live.take", z.object({ instanceId: idSchema, durationMs: durationMsSchema.optional() })),
  command(
    "live.interrupt",
    z.object({
      instanceId: idSchema,
      durationMs: durationMsSchema.optional(),
      /** Defaults to `hide`. */
      below: interruptBelowSchema.optional(),
    }),
  ),
  command("live.clearInterrupt", z.object({})),
  /** Ends any take and interrupt; the rotation continues with the next item. */
  command("live.resume", z.object({})),
  command("live.blackout", z.object({ on: z.boolean() })),
]);
export type Command = z.infer<typeof commandSchema>;
export type CommandType = Command["type"];

/** The body of `POST /api/commands`. */
export const commandRequestSchema = z.intersection(
  commandSchema,
  z.object({ expectedRevision: z.number().int().nonnegative().optional() }),
);
export type CommandRequest = z.infer<typeof commandRequestSchema>;

/**
 * Commands only the server issues, on behalf of the plugin runtime. They go through the same
 * reducer, persistence and broadcast as `Command`, but `POST /api/commands` never accepts them.
 */
export const hostCommandSchema = z.discriminatedUnion("type", [
  command("plugin.setState", z.object({ plugin: z.string().min(1), state: z.json() })),
  command(
    "plugin.setStatus",
    z.object({
      plugin: z.string().min(1),
      status: z.enum(["ok", "error"]),
      error: z.string().optional(),
    }),
  ),
  command("instance.setState", z.object({ id: idSchema, state: z.json() })),
]);
export type HostCommand = z.infer<typeof hostCommandSchema>;
