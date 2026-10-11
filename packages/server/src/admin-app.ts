import { Hono } from "hono";

/** The operator-facing app (login, /api/commands, /api/events). */
export function createAdminApp() {
  const app = new Hono();
  app.get("/", (c) => c.text("Storbild admin"));
  return app;
}
