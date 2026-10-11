import { zValidator } from "@hono/zod-validator";
import { type Command, CommandError, commandRequestSchema } from "@storbild/core";
import { Hono } from "hono";
import { createModuleRoutes, type ModuleRegistry } from "./plugins/routes.ts";
import { type StreamOptions, streamState } from "./sse.ts";
import { RevisionConflictError, type StateHub } from "./state-hub.ts";

export interface AdminAppDeps {
  hub: StateHub;
  stream?: StreamOptions;
  /** Plugin modules, also served here for the admin's preview and custom editors. */
  modules?: ModuleRegistry;
  /** Handles plugin routes under `/api/plugins/<id>/`. */
  plugins?: { handle(id: string, request: Request): Promise<Response | undefined> };
}

/** The operator-facing app (login, /api/commands, /api/events). Unauthenticated until M5. */
export function createAdminApp({ hub, stream, modules, plugins }: AdminAppDeps) {
  const app = new Hono();
  if (modules) app.route("/", createModuleRoutes(modules));
  return app
    .get("/", (c) => c.text("Storbild admin"))
    .all("/api/plugins/:id/*", async (c) => {
      const id = c.req.param("id");
      // The plugin sees paths relative to its prefix.
      const url = new URL(c.req.url);
      url.pathname = url.pathname.slice(`/api/plugins/${id}`.length) || "/";
      const response = await plugins?.handle(id, new Request(url.href, c.req.raw));
      return response ?? c.json({ error: "not_found" }, 404);
    })
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
              {
                error: error.code,
                message: error.message,
                ...(error.issues && { issues: error.issues }),
              },
              error.code === "not_found" ? 404 : 422,
            );
          }
          throw error;
        }
      },
    );
}
