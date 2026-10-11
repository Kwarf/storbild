import { Hono } from "hono";

/**
 * The screen-facing app (viewer page, /events, /time). It must never mount admin routes:
 * the screen hostname is proxied here and only here.
 */
export function createViewerApp() {
  const app = new Hono();
  app.get("/", (c) => c.text("Storbild viewer"));
  return app;
}
