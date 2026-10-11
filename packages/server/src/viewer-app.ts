import { Hono } from "hono";
import { createModuleRoutes, type ModuleRegistry } from "./plugins/routes.ts";
import { type StreamOptions, streamState } from "./sse.ts";
import type { StateHub } from "./state-hub.ts";
import { createViewerPageRoutes, type ViewerBundle } from "./viewer-page.ts";

export interface ViewerAppDeps {
  hub: StateHub;
  now: () => number;
  stream?: StreamOptions;
  /** Plugin modules and the import map. */
  modules?: ModuleRegistry;
  /** The viewer page's bundle. Without it, `/` is a 404. */
  viewer?: ViewerBundle;
}

/**
 * The screen-facing app (viewer page, /events, /time). It must never mount admin routes:
 * the screen hostname is proxied here and only here.
 */
export function createViewerApp({ hub, now, stream, modules, viewer }: ViewerAppDeps) {
  const app = new Hono();
  if (modules) app.route("/", createModuleRoutes(modules));
  if (viewer) app.route("/", createViewerPageRoutes(viewer, modules?.importMap ?? { imports: {} }));
  app.get("/events", (c) => streamState(c, hub, stream));
  app.get("/time", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ now: now() });
  });
  return app;
}
