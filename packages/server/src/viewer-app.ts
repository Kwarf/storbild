import { Hono } from "hono";
import { type StreamOptions, streamState } from "./sse.ts";
import type { StateHub } from "./state-hub.ts";

export interface ViewerAppDeps {
  hub: StateHub;
  now: () => number;
  stream?: StreamOptions;
}

/**
 * The screen-facing app (viewer page, /events, /time). It must never mount admin routes:
 * the screen hostname is proxied here and only here.
 */
export function createViewerApp({ hub, now, stream }: ViewerAppDeps) {
  const app = new Hono();
  app.get("/", (c) => c.text("Storbild viewer"));
  app.get("/events", (c) => streamState(c, hub, stream));
  app.get("/time", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ now: now() });
  });
  return app;
}
