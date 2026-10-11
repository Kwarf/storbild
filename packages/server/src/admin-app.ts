import { zValidator } from "@hono/zod-validator";
import { type Command, CommandError, commandRequestSchema } from "@storbild/core";
import { Hono } from "hono";
import { type StreamOptions, streamState } from "./sse.ts";
import { RevisionConflictError, type StateHub } from "./state-hub.ts";

export interface AdminAppDeps {
  hub: StateHub;
  stream?: StreamOptions;
}

/** The operator-facing app (login, /api/commands, /api/events). Unauthenticated until M5. */
export function createAdminApp({ hub, stream }: AdminAppDeps) {
  return new Hono()
    .get("/", (c) => c.text("Storbild admin"))
    .get("/api/events", (c) => streamState(c, hub, stream))
    .post(
      "/api/commands",
      zValidator("json", commandRequestSchema, (result, c) => {
        if (!result.success) {
          return c.json({ error: "invalid_command", issues: result.error.issues }, 400);
        }
      }),
      (c) => {
        const { expectedRevision, ...command } = c.req.valid("json");
        try {
          return c.json(hub.dispatch(command as Command, expectedRevision), 200);
        } catch (error) {
          if (error instanceof RevisionConflictError) {
            return c.json({ error: "revision_conflict", revision: error.revision }, 409);
          }
          if (error instanceof CommandError) {
            return c.json(
              { error: error.code, message: error.message },
              error.code === "not_found" ? 404 : 422,
            );
          }
          throw error;
        }
      },
    );
}
