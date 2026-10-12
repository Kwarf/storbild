// The viewer page's entry (DESIGN.md §7): the page contains <sb-viewer>, which starts syncing.
// The service worker lets the page start and play through an outage (ADR 0019).
import { registerServiceWorker } from "./service-worker.ts";
import "./viewer.ts";

registerServiceWorker();

/** Lets tests tell whether the page reloaded. */
(window as unknown as { __storbild: { bootId: string } }).__storbild = {
  bootId: `${Date.now()}-${Math.random()}`,
};
