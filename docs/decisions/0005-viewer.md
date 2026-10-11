# 5. Viewer

Date: 2026-10-11

## Status

Accepted

## Context

M3 (DESIGN.md §9) asks for the Lit viewer: a scaled stage, a sync client that survives server
restarts and network drops, and a compositor with the §7 layers, crossfades, prefetch and
plugin modules loaded through the import map. Several things weren't settled by the design:

- The scheduler arrives in M4, so nothing puts a scene on air yet.
- An SSE comment heartbeat is invisible to `EventSource`, so a watchdog can't see it.
- Browsers give up on an `EventSource` after a non-200 response, which is what a reverse
  proxy returns while the server is down.
- Nothing said how the viewer is built and served, or what happens when a plugin element
  fails.

## Decision

**An interim timeline until M4.** `interimTimeline(state, now)` in core sets `timeline.main`
to the first playlist item that is enabled, not broken and of a scene type, with no end. It
owns only `main`; `next`, `interrupt` and `blackout` are left as they are. While the pick
stays the same, `startedAt` is kept, so recomputing produces no patch. `StateHub` applies it
after every command, host command and `update`, in the same revision. M4 replaces this one
call with the scheduler. A plugin whose server part failed (`status: "error"`) still renders;
plugins that cannot load already mark their instances broken.

**The heartbeat is an event.** The server sends `event: ping` with `data: 1` every 15 s instead
of a `: ping` comment. Browsers drop events with empty data. The ping has no `id`, so the
client's last event ID, and with it `Last-Event-ID` resume, is unaffected.

**Sync client.** `SyncClient` in `packages/viewer` takes its I/O injected (the `EventSource`
factory, `fetch`, timers, `reload`), so it is unit-tested without a browser.

- It applies the snapshot and then patches. A patch whose revision isn't the current one plus
  one, or that fails to apply, closes the stream and opens a new one. A new `EventSource`
  sends no `Last-Event-ID`, so the new stream starts with a snapshot.
- If the browser has closed the stream (`readyState === CLOSED`), the client reopens it with
  backoff (1 s doubling to 30 s, reset on open). A reopened stream starts from a snapshot.
  Shows are small, so resume is left to the browser's own reconnects.
- **Watchdog.** After 60 s without a snapshot, patch or ping, the client probes `GET /time`.
  If the server answers, the page reloads, as DESIGN.md §7 asks. If not, the client opens a
  new stream, in case the old one is half-open after a silent network drop, and keeps
  waiting. Reloading while the server is unreachable would leave a kiosk on the browser's
  error page.

**Clock.** `ClockSync` takes 8 sequential `/time` samples into `estimateOffset`, then sets the
offset on `createServerClock`, which slews. It resyncs every 5 minutes, after each (re)connect
and when the page becomes visible. The local clock is `performance.timeOrigin +
performance.now()`, which is monotonic, so a local NTP step doesn't move the estimated server
time.

**Bundling and serving.**

- The host builds `@storbild/viewer/main` once per process with `Bun.build` and serves it
  immutably at `/app/<hash>/…`. As with plugin viewer modules, `lit`, `zod` and the SDK stay
  external and resolve through the import map, so the viewer and every plugin share one Lit
  and one `StorbildElement`. `@storbild/core` is bundled in.
- `/` on the viewer app is the page: the import map inline, the bundle's entry, and
  `<sb-viewer>`. It is `no-store`, so a reload after a restart picks up a new bundle.
- `bun run dev` doesn't rebuild the viewer when its sources change, because they are built
  rather than imported. Restart to pick up viewer edits.
- `@storbild/viewer` (the package root) exports the compositor, stage and sync client without
  starting anything, for the M5 admin preview.

**Compositor.**

- `<sb-compositor>` renders a state on a 1920×1080 canvas, which `<sb-stage>` scales uniformly
  and centres. The layers are those of §7: background (the active theme's colour, until M7),
  main, overlays (empty until M8), the interrupt with an optional dim, and blackout.
- Each scene layer is a `SceneLayer`. It keys elements by instance ID, so the same instance
  staying on air is never remounted; config, settings and state changes are set on the
  element in place.
- A new scene is loaded, mounted invisibly, given `prepare()`, and then crossfaded in over
  `TRANSITION_MS` (800 ms, until M6 makes it a setting). A change during a fade removes the
  outgoing scene at once, so at most two scenes are visible.
- `timeline.next` is prefetched (mounted hidden and prepared) while no fade runs, and promoted
  when it goes on air.
- Failures never escape the layer:
  - If `prepare()` throws or takes longer than 10 s, the scene is shown anyway.
  - If the module fails to load, the element isn't defined in time, or the instance is broken,
    the layer is left empty and the layers below show through. A failed load is retried on
    the next state change.
  - Lifecycle calls (`enter`, `exit`, `dispose`) are wrapped and logged.
- Custom elements can't be redefined. If a plugin whose element is already in use gets a new
  module URL (an upgrade picked up on restart), the viewer reloads the page.

**The SDK gains `pluginState`.** `StorbildElement` had a single `state` property, while server
parts write both plugin-wide state (`setPluginState`) and per-instance state
(`setInstanceState`). Viewer elements now receive the instance's state as `state` and the
plugin's as `pluginState`, typed by a fourth, defaulted type parameter. This is additive, so
`apiVersion` stays `"1"`.

**E2E tests with Playwright.** `packages/server/e2e/viewer.e2e.test.ts` drives two Chromium
windows of different sizes against an in-process server, through:

- the acceptance criteria: same content in both windows, live updates, server restart,
  network outage
- crossfade, prefetch, interrupt and blackout, and failure handling

It runs under `bun test`, and only with `STORBILD_E2E=1` set, so a plain `bun test` needs no
browser. CI installs Chromium and runs it as a separate step. A small probe plugin in
`e2e/probe-plugin` records lifecycle calls on the page.

## Consequences

- With the interim rule, the first playlist item stays on air forever. Rotation, durations and
  `next` arrive with M4, and `live.*` stays in M4.
- CI downloads Chromium on every run (about 115 MB) and needs `sudo` for the system
  dependencies.
- A viewer that reconnects from scratch receives a full snapshot rather than a resume. This is
  cheap at show sizes.
- The viewer doesn't follow `timeline.next.startsAt` on its own yet; the switch happens when
  the patch arrives. M4 adds switching at `startsAt` using `serverNow()`.
- Deferred:
  - theme CSS custom properties and fonts (M7)
  - overlay slots (M8)
  - offline continuation with `resolveTimeline` and a service worker (M10)
  - rebuilding the viewer in dev mode
