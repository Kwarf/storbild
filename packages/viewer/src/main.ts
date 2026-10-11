// The viewer page's entry (DESIGN.md §7): the page contains <sb-viewer>, which starts syncing.
import "./viewer.ts";

/** Lets tests tell whether the page reloaded. */
(window as unknown as { __storbild: { bootId: string } }).__storbild = {
  bootId: `${Date.now()}-${Math.random()}`,
};
