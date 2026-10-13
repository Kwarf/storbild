# Storbild — Design Document

Storbild is big-screen ("beamer") software for demoparties. A full-screen browser viewer runs a scheduled rotation of plugin-driven scenes and overlays. A web admin controls it, and the backend keeps every connected screen in sync over server-sent events.

This document is the source of truth for architecture and scope. It is written to be picked up by contributors and coding agents. Each milestone in [§ 9](#9-milestones) can be planned and implemented on its own, in dependency order.

---

## 1. Goals and non-goals

### Goals

- **Runs itself.** 99% of the time Storbild loops through a fixed rotation and schedule with nobody touching it. Manual control is only for announcements and the wind-up to special events.
- **One screen, plus identical mirrors.** There is one main projector screen. Extra viewers, such as a tab in the media booth or a screen in the food/drink area, show exactly the same thing. Content must match, but sync doesn't need to be frame-perfect.
- **Plugins for everything.** Slide types ("scenes") and widgets ("overlays") are plugins. Third parties can develop them in standalone repositories with full TypeScript types.
- **A party-wide look.** A theme (background, fonts, colours) applies across all plugins unless a plugin deliberately opts out.
- **Survives a bad network.** The backend runs on a cloud VPS, and the venue uplink can drop. The viewer keeps showing the rotation during an outage and recovers by itself.
- **A clean, professional admin.** It is functional and uncluttered, with no gimmicks and no generic "template" look.

### Non-goals (explicitly out of scope)

- Screen groups or different content per screen.
- Frame-accurate sync, or synchronised video playback across screens.
- Undo/redo, history or an audit log.
- Multi-user accounts or roles. The admin has a single username and password, and the whole crew is trusted.
- Sandboxing plugins. All plugins are trusted; organisers are expected to do trial runs with their full plugin set.
- Theming the admin UI. Only light/dark switching is user-facing.
- Built-in party management system (PMS) integration (Wuhu, Partymeister and so on). This is possible later as plugins, but not planned.

Low priority, nice to have if time allows, and implemented as plugins if at all: video scenes, audio.

---

## 2. Architecture overview

```
                      ┌──────────────── storbild server (Bun) ─────────────────┐
  admin.<domain> ────►│ Admin app (Hono, :3001)                                │
  (Caddy, TLS)        │   login · REST commands · admin SSE · static           │
                      │                                                        │
                      │ Core: command reducer → state (revision N) → SQLite    │
                      │       scheduler (timeline resolution)                  │
                      │       plugin host (server parts, sources)              │
                      │       asset store                                      │
                      │                                                        │
  screen.<domain> ───►│ Viewer app (Hono, :3000)                               │
  (Caddy, TLS +       │   viewer page · /events (SSE) · /time · static         │
   basic auth)        └────────────────────────────────────────────────────────┘
                                   │ SSE: snapshot + patches
              ┌────────────────────┼─────────────────────┐
         main screen          booth tab              bar screen
       (Chromium kiosk)       (any browser)          (any browser)
```

- **One process, two Hono apps on two ports.** The screen hostname can only reach viewer routes, even if the proxy is misconfigured.
- **The server is authoritative and the only writer.** Admin actions are commands sent over REST. Every accepted command produces a new state revision, which is broadcast as a patch.
- **The viewer renders on the client from state.** The server never pushes HTML. The viewer receives a JSON state (snapshot, then patches) and renders it with Lit components.
- **Time-based, not tick-based.** The state contains *when* things start and end, in server time. Viewers compute what to show from an estimated server clock, so late packets don't desync them, and hidden tabs catch up instantly.

### Tech stack

| Concern | Choice |
|---|---|
| Runtime | Bun |
| HTTP framework | Hono (`streamSSE` for SSE, `hc` typed RPC client for the admin) |
| Schemas and validation | Zod 4 (TS types, runtime validation, `z.toJSONSchema()` for admin forms) |
| Database | SQLite via `bun:sqlite` (WAL mode, `STRICT` tables) |
| Viewer UI | Lit (web components) |
| Admin UI | Lit (same component model as plugins) |
| Password hashing | `Bun.password` (argon2id) |
| Bundling | Bun bundler |
| Tests | `bun test` |
| Reverse proxy and TLS | Caddy (deployment-side, not part of the app) |
| Language | TypeScript, `strict` everywhere |

---

## 3. Repository layout

A Bun workspace monorepo:

```
storbild/
├── DESIGN.md                  # this document
├── docs/
│   ├── decisions/             # short ADRs for decisions made during implementation
│   ├── plugin-authoring.md    # written in M10b
│   └── deployment.md          # written in M10b
├── packages/
│   ├── core/                  # pure, shared logic: state types, timeline resolution,
│   │                          # patch helpers, clock-offset math. No I/O. Used by
│   │                          # server AND viewer.
│   ├── plugin-sdk/            # published as @storbild/plugin-sdk: definePlugin, types,
│   │                          # field helpers, Lit base classes, admin form components,
│   │                          # z re-export
│   ├── server/                # Bun + Hono: apps, commands, persistence, scheduler,
│   │                          # plugin host, SSE, assets
│   ├── viewer/                # Lit viewer app (compositor, sync client)
│   └── admin/                 # Lit admin app
├── plugins/                   # built-in plugins, written ONLY against the public SDK
│   ├── markdown/
│   ├── slideshow/
│   ├── countdown/
│   ├── announcement/
│   └── info/
├── templates/
│   └── plugin/                # starting point for third-party plugins (ADR 0026)
└── deploy/
    ├── Caddyfile.example
    ├── storbild.service       # systemd unit
    ├── Containerfile          # Docker/Podman image
    ├── compose.yaml           # Storbild and Caddy, for docker or podman compose
    ├── storbild.container     # Podman Quadlet unit
    └── kiosk/                 # Chromium kiosk setup and launch scripts (ADR 0027)
```

**Rule:** built-in plugins may import only `@storbild/plugin-sdk` (and their own deps). If a built-in plugin needs something internal, that is a gap in the SDK. Fix the SDK, not the plugin.

---

## 4. Domain model

All types live in `packages/core` and are defined as Zod schemas, with TS types inferred from them.

### 4.1 Plugins, instance types, instances

There are three levels:

1. **Plugin:** installed code with an `id` and `version`. It has **settings**: one plugin-wide config, validated by the plugin's settings schema.
2. **Instance type:** something a plugin contributes, either a `scene` (full-screen content) or an `overlay` (a widget). Each type has its own **config schema**. A plugin usually has one type but may have several.
3. **Instance:** a named, configured copy of an instance type, such as "Rules" or "Welcome" (both `markdown/text`). Instances live in a **library**. The playlist and cues *reference* instances by ID.

```ts
interface Instance {
  id: string;
  plugin: string;            // "markdown"
  type: string;              // "text"
  name: string;              // "Rules"
  config: unknown;           // validated by the type's config schema
  configVersion: number;     // for migrations
  background?: "theme" | "none" | { assetId: string; fit: "cover" | "contain" };
  state?: unknown;           // runtime data written by the plugin's server part
  error?: string;            // set by the plugin host when the instance is broken
}
```

- An instance can appear several times in the playlist. Instances that aren't in the playlist (for example a pre-made "Fire exit" announcement) can be taken live or used as interrupts.
- Settings vs. config inheritance is the **plugin's** responsibility. Make the config field optional and resolve it as `config.x ?? settings.x`. There is no generic merge in the core.
- An instance that fails validation after migration, or whose plugin or type is unavailable, is marked **broken** (`error` is set). It is skipped by the scheduler and flagged in the admin, and it never crashes the show.

### 4.2 Playlist (rotation)

```ts
interface PlaylistItem {
  id: string;
  instanceId: string;
  enabled: boolean;
  durationMs?: number;          // overrides the type's computed duration
  activeFrom?: number;          // optional time window, epoch ms (server time)
  activeUntil?: number;
}
```

- The rotation loops through items that are enabled, not broken, and inside their time window at the moment they would start. A started item plays to its end.
- **Duration is always determined on the server.** It is the item override, or the instance type's `duration(config, settings)`, or the show's default duration (`settings.defaultDurationMs`, 15 s unless changed; [ADR 0010](docs/decisions/0010-admin-forms-and-content-pages.md)). The resolved value is stored in state as `resolvedDurationMs`, so the viewer never needs plugin server code. Scenes cannot end themselves from the client.
- Editing the playlist never restarts the show: the item on air keeps playing if it is still eligible, otherwise the rotation continues with the item after it ([ADR 0006](docs/decisions/0006-scheduler-and-timeline.md)).

### 4.3 Schedule cues

Timed actions at an absolute time:

```ts
interface Cue {
  id: string;
  at: number;                                  // epoch ms, server time
  action:
    | { type: "take"; instanceId: string; durationMs?: number }
    | { type: "interrupt"; instanceId: string; durationMs?: number; below?: "show" | "dim" | "hide" }
    | { type: "activateTheme"; themeId: string };
  fired?: boolean;
}
```

A due cue is applied as of its own `at` and marked `fired`; one whose take or interrupt would already have ended has no effect. Recurring cues are out of scope for the first version.

### 4.4 Live control and timeline

`Timeline` is the **resolved** output of the scheduler, which is what viewers render:

```ts
interface Timeline {
  mode: "auto" | "override";   // override = a manual take or interrupt is active
  main?: { instanceId: string; itemId?: string; startedAt: number; endsAt?: number }; // absent: background only
  next?: { instanceId: string; itemId?: string; startsAt: number };
  interrupt?: { instanceId: string; startedAt: number; endsAt?: number; below: "show" | "dim" | "hide" };
  blackout: boolean;
}
```

Live control is the input that `resolveTimeline` combines with the rotation:

```ts
interface Live {
  main?: { instanceId: string; itemId?: string; startedAt: number; endsAt?: number };  // a take, or the scene frozen under an interrupt
  interrupt?: { instanceId: string; startedAt: number; endsAt?: number; below: "show" | "dim" | "hide" };
  blackout: boolean;
}
```

Semantics:

- **Take now** replaces `main` for its duration, or until resumed when it has none. Then the rotation continues with the item after the one it replaced.
- **Interrupt** shows on the interrupt layer above everything except blackout. By default the theme background covers the scene and overlays beneath it, so any scene works as an announcement; `below` can instead dim them or leave them visible, for interrupts that draw their own panel ([ADR 0008](docs/decisions/0008-interrupt-backdrop.md)). It ends after its duration, or when dismissed if it has none. While it is active the rotation is paused: the scene on air stays frozen beneath. When it ends, the rotation continues with the next item, not by restarting the interrupted one. (This is a deliberate simplification; record it in an ADR if it changes.)
- **Blackout** always wins. It renders pure black, and the timeline keeps advancing underneath.
- **The rotation is deterministic.** It is anchored at `playlist.anchorAt` and `playlist.anchorItemId`, and the position at time *t* is computed from the anchor and the resolved durations of the eligible items. The anchor is only moved when the rotation's content changes or by a take or interrupt. This makes `resolveTimeline(state, t)` a **pure function** in `packages/core`, used by both the server (authoritative) and the viewer (to switch on time and keep going during outages).
- `next` is announced as soon as the current scene starts, whenever the following scene is known.

The scheduler's rules (anchoring, edits, cues, the server timer) are specified in [ADR 0006](docs/decisions/0006-scheduler-and-timeline.md).

### 4.5 Overlays

```ts
type OverlaySlot =
  | "top-left" | "top" | "top-right"
  | "left" | "right"
  | "bottom-left" | "bottom" | "bottom-right"
  | "top-bar" | "bottom-bar";

interface OverlayPlacement {
  instanceId: string;          // an instance of an overlay type
  slot: OverlaySlot;
  order: number;               // position within the slot's stack
  visible: boolean;
}
```

- **Fixed slots with stacking.** Several widgets per slot are allowed. Each slot is a flex container that stacks toward the screen centre: vertically for corners and `left`/`right`, horizontally for `top`/`bottom`. Gaps come from the theme.
- **No free x/y positioning, and no centre slot.** The centre belongs to scenes and interrupts.
- Widgets size themselves. A slot may cap the maximum width or height.
- Slots sit inside the theme's safe area.
- Scene types can declare `reserveSlots: OverlaySlot[]` (those widgets fade out while the scene is live) or `hideOverlays: true` (all widgets fade out).
- A widget whose data is stale (for example now-playing with no update for N minutes) hides itself, and the rest of the stack closes the gap. It says when through the SDK's `staleAt()` hook.

The `overlay.*` commands, the slot grid and its size caps, which scenes' reservations count, and how widgets fade and leave their stack are specified in [ADR 0012](docs/decisions/0012-overlays.md).

### 4.6 Themes

```ts
interface Theme {
  id: string;
  name: string;
  background:
    | { type: "color"; color: string }
    | { type: "image"; assetId: string; fit: "cover" | "contain"; dim?: number }
    | { type: "video"; assetId: string; dim?: number }
    | { type: "scene"; instanceId: string };       // plugin-rendered, e.g. WebGL
  fonts: { heading: FontRef; body: FontRef; mono?: FontRef };
  colors: { text: string; muted: string; accent: string; surface: string };
  safeArea?: number;           // px on the 1920×1080 canvas, default 96
  gap?: number;                // px between overlay widgets, default 24 (ADR 0012)
  customCss?: string;          // escape hatch, viewer-scoped, at your own risk
}

interface FontRef {
  family: string;              // without faces: a font the screens have, e.g. "sans-serif"
  faces?: { assetId: string; weight: number; style: "normal" | "italic" }[];  // uploaded woff2
}
```

- Several themes can be stored, with one active (`activeThemeId`). Switching themes is just a state patch. The active theme can't be deleted.
- **The background is a compositor layer**, not a plugin concern. Scenes are transparent by default. A scene type can declare `background: "own"` (for example a full-bleed slideshow), in which case the compositor fades the theme background out while it is live. Per instance, `Instance.background` overrides this: the theme's, none, or an image drawn beneath the scene.
- When two consecutive scenes both use the theme background, it does **not** transition; only the content crossfades.
- Theme values are exposed as CSS custom properties on the viewer root. They inherit through shadow DOM:

```css
--sb-font-heading; --sb-font-body; --sb-font-mono;
--sb-color-text; --sb-color-muted; --sb-color-accent; --sb-color-surface;
--sb-safe-area; --sb-gap;
```

- Uploaded fonts are added to the viewer document with the FontFace API, under a family name unique to their files. The compositor applies a theme only once its fonts have loaded (or after 5 s), keeping the previous theme until then and drawing nothing before the first, so no fallback font is ever shown.
- `customCss` applies inside the compositor's shadow root, after its own styles.

The commands, fonts, the background layer, scene backgrounds, the interrupt cover and the Theme page are specified in [ADR 0014](docs/decisions/0014-theming.md).

### 4.7 Assets

- Uploaded files (images, fonts and MP4/WebM video) are stored on disk named by their SHA-256, with metadata (name, MIME type, size, dimensions, whether there is a thumbnail) in SQLite. The admin makes the thumbnails, so the server needs no image library.
- Assets are served immutably at `/assets/<hash>` with long cache headers, on both apps. Replacing an asset (a new hash, with the instances referencing it updated) is deferred.
- The type is sniffed from the content and the size is limited (`STORBILD_MAX_UPLOAD_MB`, and `STORBILD_MAX_VIDEO_UPLOAD_MB` for video) on upload. Uploads are streamed to disk, never held whole in memory ([ADR 0014](docs/decisions/0014-theming.md)). User uploads are never served as a page (`nosniff` and a sandboxing CSP).
- An asset that an instance or theme uses can't be deleted.

Uploads, sniffing, serving, the asset picker and deletion are specified in [ADR 0011](docs/decisions/0011-assets-schedule-and-quick-announce.md). Sniffing uses file-type and image-size ([ADR 0021](docs/decisions/0021-file-type-and-image-size-for-sniffing.md)).

**Show files.** The whole show can be exported as one zip (`show.json` plus the assets and their thumbnails) and imported into another install, replacing its show in one revision. Runtime data (live control, the timeline, plugin and instance state, the rotation's anchor) isn't exported ([ADR 0019](docs/decisions/0019-resilience-and-show-files.md)). The zip is written and read with zip.js ([ADR 0020](docs/decisions/0020-zip-js-for-show-files.md)).

### 4.8 Full state

```ts
interface ShowState {
  revision: number;
  plugins: Record<string, PluginEntry>;
  instances: Record<string, Instance>;
  playlist: { items: PlaylistItem[]; anchorAt: number; anchorItemId?: string };
  cues: Cue[];
  overlays: OverlayPlacement[];
  themes: Record<string, Theme>;
  activeThemeId: string;
  live: Live;                  // input: takes, interrupts, blackout
  timeline: Timeline;          // output: the server's resolution at the latest revision
  assets: Record<string, AssetMeta>;
  settings: { defaultDurationMs: number; transitionMs: number };   // show-wide defaults
}
```

```ts
interface PluginEntry {
  version?: string;
  status: "ok" | "incompatible" | "error" | "missing";  // missing: data stored, plugin gone
  error?: string;
  settings: unknown;
  state: unknown;
  module?: string;             // versioned viewer module URL
  adminModule?: string;        // versioned admin module URL (custom editors)
  types: Record<string, { kind: "scene" | "overlay"; label: string; viewer: string; /* … */ }>;
}
```

The viewer stream receives the full `ShowState`. Each plugin entry carries what the viewer needs without plugin code: the versioned module URL and, per type, its element and compositor hints. Only settings and state are owned by the show; the plugin host recomputes the rest on load ([ADR 0004](docs/decisions/0004-plugin-sdk-and-host.md)).

---

## 5. Sync protocol

### 5.1 Viewer stream: `GET /events` (SSE)

- The first message is `event: snapshot`, `id: <revision>`, `data: <ShowState JSON>`.
- After that comes `event: patch`, `id: <revision>`, `data: <RFC 6902 JSON Patch array>`. Patches target the narrowest path, so a now-playing update touches only `plugins.now-playing.state`.
- **Resume.** On reconnect the browser sends `Last-Event-ID`. If the server's ring buffer still holds patches after that revision, it replays them; otherwise it sends a fresh snapshot.
- **Heartbeat.** The server sends an `event: ping` (data `1`, no `id`) every 15 s, and a `retry: 2000` field on connect. It is an event rather than a comment so the viewer's watchdog can observe it ([ADR 0005](docs/decisions/0005-viewer.md)).
- **Headers.** `Content-Type: text/event-stream`, `Cache-Control: no-cache`, no compression.
- The viewer keeps track of connected streams for a "connected screens" count in the admin.

### 5.2 Clock offset: `GET /time`

- The server returns `{ now: <epoch ms> }`. The client takes 5–10 samples, keeps those with the lowest round-trip time, and estimates `offset = serverNow − (t0 + t3)/2`, using the median.
- It re-syncs every 5 minutes and after reconnects. Offset changes are smoothed, so animations never jump.
- `serverNow()` from `packages/core` is the **only** clock that viewer and plugin code may use for scheduling.

### 5.3 Admin

- Commands: `POST /api/commands` with `{ type, payload, expectedRevision? }`. The server validates against Zod, applies the command, persists, broadcasts, and returns `{ revision }`, plus `id` for commands that create an entity. An invalid body returns `400`, an unknown ID `404`, and a command that doesn't fit the current state `422`. A stale `expectedRevision` returns `409`, and the client refetches. Last write wins otherwise.
- Deleting an instance also removes the playlist items, overlay placements and cues that reference it, in the same revision.
- Admin stream: `GET /api/events`, the same protocol as the viewer, behind the session.
- Typed client: the admin uses Hono's `hc` client typed from the admin app.

### 5.4 Command catalogue (initial)

```
instance.create | instance.update | instance.delete
playlist.addItem | playlist.updateItem | playlist.removeItem | playlist.reorder
cue.create | cue.update | cue.delete
plugin.updateSettings | plugin.remove
settings.update
overlay.place | overlay.update | overlay.remove
theme.create | theme.update | theme.delete | theme.activate
live.take | live.interrupt | live.clearInterrupt | live.resume | live.blackout
```

`live.take` and `live.interrupt` take `{ instanceId, durationMs?, … }`; without a duration they hold until `live.resume` or `live.clearInterrupt` ([ADR 0006](docs/decisions/0006-scheduler-and-timeline.md)).

M1 implements `instance.*` and `playlist.*`. The others arrive with the milestone that gives them meaning: `plugin.updateSettings` in M2, `live.*` in M4, `settings.update` and `plugin.remove` (only for a `missing` plugin) in M6a, `cue.*`, `asset.update` and `asset.delete` in M6b, `theme.*` in M7 and `overlay.*` in M8 ([ADR 0003](docs/decisions/0003-state-sync-and-persistence.md), [ADR 0010](docs/decisions/0010-admin-forms-and-content-pages.md), [ADR 0011](docs/decisions/0011-assets-schedule-and-quick-announce.md)). Assets are added by uploading them, which issues the host-only `asset.add`. A cue's `at` must be in the future, and a fired cue can only be deleted. `overlay.place` takes an instance of an overlay type and a slot, each instance is placed at most once, and `overlay.update` moves a placement within or across slots ([ADR 0012](docs/decisions/0012-overlays.md)). A theme's files must exist and be of the right kind, the active theme can't be deleted, and deleting a theme removes the unfired cues that would activate it ([ADR 0014](docs/decisions/0014-theming.md)).

`GET /api/show/export` downloads the show file, and `POST /api/show/import` replaces the show with one through the host-only `show.import` ([ADR 0019](docs/decisions/0019-resilience-and-show-files.md)).

From M2, instance config and plugin settings are validated by the plugin's schemas: an unknown plugin or type is `404`, and an invalid config or settings value is `422` with `issues`. The plugin runtime writes through host-only commands (`plugin.setState`, `plugin.setStatus`, `instance.setState`), which `POST /api/commands` does not accept ([ADR 0004](docs/decisions/0004-plugin-sdk-and-host.md)).

---

## 6. Plugin system

### 6.1 Authoring

Plugins can live in standalone repositories. They depend only on `@storbild/plugin-sdk`.

```ts
import { definePlugin, fields, z } from "@storbild/plugin-sdk";

export default definePlugin({
  id: "markdown",
  version: "1.0.0",
  apiVersion: "1",
  settings: z.object({ fontScale: z.number().default(1) }),
  types: {
    text: {
      kind: "scene",
      label: "Markdown text",
      config: z.object({ content: fields.markdown() }),
      duration: () => 15_000,              // optional; else the show's default
      viewer: "sb-markdown-scene",
      // editor: "sb-markdown-editor",   // optional custom admin element
      // background: "theme" | "own",    // default "theme"
      // reserveSlots, hideOverlays, singleton
    },
  },
  server: async (ctx) => { /* optional */ },
});
```

`definePlugin()` infers types from the Zod schemas. The server part's settings and instances are typed automatically, and viewer elements get theirs with `PluginConfig<typeof plugin, "text">` and `PluginSettings<typeof plugin>`.

A plugin package's `exports["."]` is the definition module above, which only the server loads. Its browser entry, which registers the viewer elements, is named in `package.json` as `"storbild": { "viewer": "./src/viewer.ts" }`. An optional `"admin": "./src/admin.ts"` entry registers custom editors and is loaded only by the admin. The SDK is split the same way: `@storbild/plugin-sdk` (definition, `z`, `fields`, types), `@storbild/plugin-sdk/viewer` (Lit base classes), `@storbild/plugin-sdk/admin` (form components) and `@storbild/plugin-sdk/build` (build preset).

### 6.2 A plugin has three faces

- **Viewer:** Lit elements extending `StorbildScene<Config, Settings>` or `StorbildOverlay<...>`.
  - Props: `config`, `settings`, `state` (the instance's runtime data), `pluginState` (the plugin's), `ctx` (`serverNow()`, `assetUrl(id)`). The theme reaches plugins as the CSS variables of §4.6 ([ADR 0014](docs/decisions/0014-theming.md)).
  - Lifecycle: `prepare()` (preload; awaited before the scene is used), `enter(at)`, `exit(at)`, `dispose()`.
  - Overlays may override `staleAt()`, the server time at which their data goes stale; the compositor then fades them out and closes the gap ([ADR 0012](docs/decisions/0012-overlays.md)).
  - Scenes don't implement transitions. The compositor owns them.
- **Admin:** by default, forms are generated from the config and settings JSON Schema (`z.toJSONSchema()`) using the SDK's form components, `<sb-form>` and `<sb-field>`. The `fields` helpers (`markdown`, `color`, `duration`, `datetime`, `asset`) tag a schema with the widget it needs. A plugin may provide a custom editor element in its admin module, built from the same components (text, markdown, number, colour, duration, datetime, select, list and the asset picker), so it looks native ([ADR 0010](docs/decisions/0010-admin-forms-and-content-pages.md), [ADR 0011](docs/decisions/0011-assets-schedule-and-quick-announce.md)).
- **Server (optional):** `server(ctx)` runs when the plugin is loaded. Its context offers:
  - `ctx.settings()` and `ctx.onSettingsChange(cb)`
  - `ctx.instances(type?)` and `ctx.onInstancesChange(cb)`
  - `ctx.setPluginState(value)` and `ctx.setInstanceState(id, value)`, which produce patches
  - `ctx.route(request => response)`, a fetch handler for extra admin-side HTTP routes under `/api/plugins/<id>/`, such as webhooks
  - `ctx.log`, plus an abort signal for shutdown

  Server parts run in-process. The host wraps them in error handling and restarts failed sources with backoff.

### 6.3 Loading, sharing and compatibility

- The host discovers plugins in `plugins/` (built-ins and dropped-in folders) and any configured package names.
- Plugins ship **built ESM plus `.d.ts`**. `lit`, `zod` and `@storbild/plugin-sdk` are `peerDependencies` and are marked **external** in plugin builds. The SDK provides a build preset.
- In the browser, an **import map** generated by the host (`/importmap.json`) resolves `lit`, `zod` and `@storbild/plugin-sdk` to the host's single copies under `/vendor/<hash>/`. On the server, the host bundles each plugin's definition module with `Bun.build`, pointing the same modules at its own copies, and bundles the viewer entry for the browser. Plugins may ship TypeScript or built ESM ([ADR 0004](docs/decisions/0004-plugin-sdk-and-host.md)).
- Modules are served at `/plugins/<id>/<version>/…`, with version in the path, so caching is safe. The viewer dynamically `import()`s only the plugins used by the current state.
- `apiVersion` is checked on load. An incompatible plugin gets `status: "incompatible"`, which is shown in the admin and never crashes the host.
- Each instance type may export `migrate(fromVersion, config)`. The host migrates and then validates stored config on load.
- **Dev mode.** `STORBILD_PLUGIN_PATHS=/path/to/my-plugin` loads a plugin from a local path. With `STORBILD_PLUGIN_WATCH=1`, the host also reloads it when its files change. Module URLs carry a content hash, so a rebuilt module always gets a new URL ([ADR 0025](docs/decisions/0025-plugin-reload.md)).

### 6.4 Built-in plugins (planned)

| Plugin | Types | Notes |
|---|---|---|
| `markdown` | scene `text`, overlay `widget` | Markdown body, headings included (`marked`, sanitized with DOMPurify); theme typography; alignment per instance. The scene shrinks to fit; the widget wraps in its slot. Polished in M9; the separate title was dropped in [ADR 0017](docs/decisions/0017-markdown-without-title.md), and the widget added in [ADR 0018](docs/decisions/0018-markdown-widget.md) |
| `slideshow` | scene `images` | Multiple images; duration = count × per-image time; `background: "own"`. Built in M6b |
| `countdown` | scene `countdown`, overlay `widget` | Target time; renders `target − serverNow()`; the overlay hides a while after the target. Built in M9 |
| `announcement` | scene `announcement` | Big-text message on an opaque panel; intended for interrupts and takes. Built in M6b |
| `info` | overlay `wifi`, overlay `clock` | SSID/password plus QR code, with a custom editor that previews it; clock. The clock is built in M8, Wi-Fi in M9 |

`now-playing` (an overlay fed by an upstream SSE stream) will be an external plugin in its own repository, because its upstream service is private ([ADR 0015](docs/decisions/0015-built-in-plugins.md)). Plugin dependencies, rendering and the countdown and Wi-Fi rules are specified there too.

---

## 7. Viewer

- **Canvas.** A fixed logical 1920×1080 stage, scaled uniformly with CSS `transform` to the window and letterboxed for other aspect ratios. Mirrors in odd-sized windows look identical.
- **Layers, bottom to top:**
  1. theme background
  2. `main` (current scene, plus the incoming scene during a transition)
  3. overlay slots
  4. interrupt, beneath which the scene and overlays fade out so the theme background covers them (`hide`, the default), are dimmed (`dim`) or are left visible (`show`) ([ADR 0008](docs/decisions/0008-interrupt-backdrop.md), [ADR 0014](docs/decisions/0014-theming.md))
  5. blackout
- **Transitions.** Owned by the compositor. The first version has a crossfade, 800 ms unless changed in the show's settings (`settings.transitionMs`); more can come later. At most two scenes are visible at once. Scenes are keyed by instance, so an instance that stays on air is updated in place, never remounted.
- **Prefetch.** When `timeline.next` appears, the viewer loads the plugin module, creates the element and awaits `prepare()` (image decode, fonts) before `startsAt`.
- **Robustness:**
  - The EventSource reconnects automatically. If the browser gives up (for example on a proxy 502), the viewer reopens it with backoff.
  - A watchdog reloads the page if there's no message or heartbeat for 60 s, but only if the server answers `/time`. Otherwise it reopens the stream and keeps waiting, so a kiosk is never left on an error page.
  - A failing scene never stops the show. If `prepare()` fails, the scene is shown anyway; if its module can't load, only the layers below show.
  - The compositor renders `resolveTimeline(state, serverNow())` and resolves again at the next boundary, so it switches at `next.startsAt` even when the patch is late, and keeps the rotation going during outages. A screen clock that trails just behind a fresh anchor resolves at the anchor ([ADR 0013](docs/decisions/0013-screen-clock-lag-at-the-anchor.md)). On `visibilitychange` it re-resolves at once.
  - **Offline starts.** A service worker precaches the page, bundles and plugin modules, and caches the assets the show uses. The viewer keeps its last state and clock offset, and starts from them when the server doesn't answer, so a reload during an outage keeps playing. A small "Offline · last update …" pill shows when a screen has been out of touch for 10 s ([ADR 0019](docs/decisions/0019-resilience-and-show-files.md)).
Sync client, bundling and failure handling are specified in [ADR 0005](docs/decisions/0005-viewer.md).

- **Kiosk.** Chromium launched with `--kiosk --noerrdialogs --disable-session-crashed-bubble --no-first-run --autoplay-policy=no-user-gesture-required --disable-pinch --overscroll-history-navigation=0 --disable-component-update`, with a dedicated profile and screen blanking disabled, under the `cage` Wayland compositor on Debian, Ubuntu or Raspberry Pi OS. Chromium updates are held. Scripts go in `deploy/kiosk/` ([ADR 0027](docs/decisions/0027-kiosk.md)).

---

## 8. Admin

### 8.1 Auth

- **A single user.** The username and an argon2id password hash (`Bun.password`) come from config or the environment. A `storbild hash-password` CLI helper generates the hash.
- **Session.** An HttpOnly, Secure, SameSite=Lax session cookie, **host-only** (no `Domain` attribute). Sessions are stored in SQLite. Secure is dropped only when the admin URL is plain http, in development.
- **Login protection.** Login attempts are rate-limited.
- Everything under `/api/` needs a session, and state-changing requests must carry a matching `Origin` ([ADR 0007](docs/decisions/0007-admin-foundation.md)).

### 8.2 Structure

- **Left sidebar:** Live · Rotation · Schedule · Library · Overlays · Theme · Plugins · Settings.
- **Pinned now/next strip:** a small live preview (the real viewer at reduced scale, driven by the admin's state; no second stream), the current scene with time remaining, the next scene, and the active overlays. Also a prominent **auto vs. override indicator**, for example "Announcement active, returns to rotation in 2:30".
- **Live panel:**
  - **Announce:** pick an instance, or type a quick message, which creates an announcement instance that stays in the library.
  - **Take now** and **Resume rotation**.
  - **Blackout:** a guarded control (hold to activate).
- **Rotation:** dense rows with drag-to-reorder, inline duration and enabled toggle, and time windows.
- **Schedule:** a day-ordered list of cues.
- **Library:** instances split into scenes and overlays, then grouped by type; the new-instance type picker is split the same way. The right-hand panel edits the selected instance and shows a live preview.
- **Overlays:** a slot diagram plus the placement list.
- **Theme:** a theme editor with live preview, and activation.
- **Plugins:** status and settings per plugin.
- **Settings:** global defaults (default duration, transition length), stored in state, and the show file: export, and import that replaces the show.

### 8.3 Visual design

The admin should be clean, professional and functional, without clutter or gimmicks. Avoid the generic "template" look.

- **Type.** One deliberate sans family (for example Instrument Sans, Hanken Grotesk, Public Sans or IBM Plex Sans; **not** Inter or Geist), with a four- or five-step type scale and two weights. Use `tabular-nums` for all times and durations.
- **Colour:**
  - A neutral palette with a slight warm or cool cast of its own (not stock "slate").
  - One accent colour.
  - Status colours used only for meaning: live, scheduled, override, error.
- **Shape.** Rows and tables rather than cards. Hairline dividers, no shadows, gradients or glassmorphism. A 2–4 px radius. No emoji or illustrations.
- **Motion.** Only where it carries information: progress of the current scene, and state changes.
- **Theming.** Light and dark modes (default to the system preference, with a toggle). Design tokens are internal CSS custom properties; there is no user-facing admin theming.
- **SDK components.** The SDK's form components use the same tokens, so plugin editors match automatically.

---

## 9. Milestones

Each milestone is meant to be planned and implemented as a separate unit of work. Every milestone lists its dependencies, scope, acceptance criteria and what is explicitly deferred. Milestones on parallel branches of the dependency graph can be worked on independently.

```
M0 ─► M1 ─► M2 ─┬─► M3 ─┬─► M4 ─────────────────────────┐
                │       ├─► M7 (theming)                 │
                │       └─► M8 (overlays)                ├─► M10a (resilience, export) ─► M10b (ops, release)
                └─► M5 ─► M6a (forms, pages) ─► M6b ─────┤   M6b: assets, schedule, announce
                    M9 (built-in plugins) ───────────────┘   (M9 needs M2+M3; grows alongside)
```

M6 is split into M6a and M6b ([ADR 0009](docs/decisions/0009-split-m6.md)), and M10 into M10a and M10b ([ADR 0016](docs/decisions/0016-split-m10.md)).

### M0 — Repository foundation

**Depends on:** nothing.

- A Bun workspace with the packages from §3. Strict TS config, linting and formatting (Biome), `bun test`, and CI running typecheck, lint and test.
- Config loading from the environment: ports, data directory, admin credentials hash, plugin paths, public URLs.
- `deploy/Caddyfile.example` with `screen.<domain>` (basic auth, proxy to :3000) and `admin.<domain>` (proxy to :3001).
- `docs/decisions/0001-record-architecture-decisions.md`.

Configuration variables, per-package TypeScript settings, lint-enforced import rules and CI are specified in [ADR 0002](docs/decisions/0002-configuration-and-tooling.md). CI runs on GitHub Actions ([ADR 0022](docs/decisions/0022-move-to-github.md)).

**Done when:** `bun install && bun test && bun run typecheck` pass in CI, and `bun run dev` starts both (empty) Hono apps on their ports.

### M1 — Core state, persistence and sync

**Depends on:** M0.

- `packages/core`: Zod schemas and types for the whole of §4 (types only for parts implemented later), JSON Patch helpers, and the clock-offset estimator.
- Server:
  - A command bus with a reducer, revisions, and SQLite persistence of content (instances, playlist, cues, overlays, themes, plugin settings) and a runtime-state checkpoint.
  - The `instance.*` and `playlist.*` commands. Other commands come with their milestones.
  - Restart restores everything.
- Viewer SSE `/events` exactly per §5.1, including the ring buffer, `Last-Event-ID` resume, heartbeat and snapshot fallback.
- `GET /time`.
- Admin `POST /api/commands` and `GET /api/events`, temporarily without auth (auth comes in M5).

**Done when:** tests cover the reducer, persistence round-trip and patch generation. An integration test connects an SSE client, applies commands, disconnects, reconnects with `Last-Event-ID` and receives exactly the missed patches, or a snapshot when the buffer has rolled past.

**Deferred:** the scheduler (M4); a placeholder timeline is fine.

Mechanics (pure reducer in core, diff-based patches, table layout, resume rules) are specified in [ADR 0003](docs/decisions/0003-state-sync-and-persistence.md).

### M2 — Plugin SDK and plugin host

**Depends on:** M1.

- `@storbild/plugin-sdk`: `definePlugin` with type inference, `StorbildScene`/`StorbildOverlay` Lit base classes (props and lifecycle), the server context types, `z` re-export, and the build preset (externals).
- Host:
  - Discovers and loads plugins (built-in folder plus `STORBILD_PLUGIN_PATHS`).
  - Checks `apiVersion`, runs migrations, validates settings and instance config (broken or incompatible plugins and instances are reported, not fatal).
  - Runs server parts with error isolation.
  - Serves versioned modules and generates the import map.
- Instance, settings and `setPluginState`/`setInstanceState` commands and patches.
- A minimal `plugins/markdown` built against the public SDK only, used as the test fixture.

**Done when:** a plugin in a separate directory outside the repo, depending only on the SDK, loads with full type checking. Its settings and instances validate. A server part can write plugin state and the resulting patch appears on `/events`.

Package shape, bundling, module serving, state representation and failure handling are specified in [ADR 0004](docs/decisions/0004-plugin-sdk-and-host.md). Reloading plugins from `STORBILD_PLUGIN_PATHS` on change is deferred to M10b ([ADR 0025](docs/decisions/0025-plugin-reload.md)).

### M3 — Viewer

**Depends on:** M2.

- A Lit viewer app served at `/` on the viewer app. Scaled 1920×1080 stage, letterboxed.
- Sync client: EventSource, snapshot and patch application, clock offset and `serverNow()`, re-sync, watchdog reload, `visibilitychange` handling.
- Compositor: the layer stack from §7, crossfade transitions, at most two mounted scenes, prefetch with `prepare()`, and dynamic module loading via the import map.
- The background layer supports a plain colour (full theming comes in M7). The overlay layer exists but is empty (M8).

**Done when:** two browser windows of different sizes show the same `markdown` instance. Changing the instance in the admin API updates both. Killing and restarting the server or the network recovers without a manual reload.

Until M4, an interim rule puts the first enabled playlist item on air. The heartbeat becomes an observable `ping` event, and viewer elements gain `pluginState` next to `state`. These, the sync client, bundling, compositor behaviour and the Playwright e2e tests are specified in [ADR 0005](docs/decisions/0005-viewer.md).

### M4 — Scheduler and timeline

**Depends on:** M1, M3 (for visual verification).

- A pure `resolveTimeline(state, t)` in `packages/core`, implementing §4.2–4.4:
  - Deterministic rotation from `anchorAt` and resolved durations.
  - Time windows and skipping broken instances.
  - Take, interrupt (with dim), resume and blackout.
  - `next` pre-announcement (at least 10 s before `startsAt`).
- Server: computes resolved durations, fires cues at their time, sets the timeline in state, and schedules a timer for the next transition. Recomputes on any relevant command.
- The viewer switches at `startsAt` using `serverNow()`, even if the patch arrives late.
- `live.*` commands.

**Done when:** extensive unit tests of `resolveTimeline` cover loops, windows opening and closing mid-rotation, take and interrupt then resume, blackout, and an empty or all-disabled playlist (fall back to theme background only). A manual test shows the rotation running unattended across two viewers.

Live control as a separate `live` input, the anchor item, rotation and edit rules, durations, cues, the server timer and the viewer's own resolution are specified in [ADR 0006](docs/decisions/0006-scheduler-and-timeline.md).

### M5 — Admin foundation

**Depends on:** M1. Can run in parallel with M3/M4.

- Auth per §8.1 (login page, sessions, rate limit, `hash-password` CLI); `/api/*` is protected.
- A Lit admin shell: design tokens, light/dark, sidebar, the pinned now/next strip with embedded preview (reusing the viewer compositor in a scaled container, fed from the admin's stream), and the auto/override indicator.
- Live panel: announce (with an existing instance), take now, resume, blackout (guarded).
- A typed API client (`hc`).

**Done when:** an operator can log in, see what's on screen and what's next, and take or interrupt or blackout and resume. The visual design follows §8.3 (review with screenshots in both modes).

Sessions, the cookie, rate limiting, the origin check, which routes are public, bundling, the font, the typed client and the Live panel's controls are specified in [ADR 0007](docs/decisions/0007-admin-foundation.md).

### M6a — Admin forms and content pages

**Depends on:** M2, M4, M5.

- A schema-driven form renderer from `z.toJSONSchema()`, built from the SDK form components (text, markdown, number, colour, duration, datetime, list), with custom editor support (§6.2). The asset picker comes in M6b.
- Pages:
  - **Library:** CRUD for instances, grouped by type, with live preview.
  - **Rotation:** reorder, durations, enable, time windows.
  - **Plugins:** status and settings.
  - **Settings:** global defaults: the default rotation duration and the transition length, which become settings in state instead of constants.

**Done when:** a show of text scenes (for example `markdown`) can be built from scratch in the admin, with no API calls or SQL, and runs unattended.

**Deferred:** the asset store, the Schedule page and quick announce (M6b).

Show settings in state, the JSON Schema endpoint, the `fields` helpers, the SDK's admin subpath, custom editor modules, `plugin.remove` and the pages are specified in [ADR 0010](docs/decisions/0010-admin-forms-and-content-pages.md).

### M6b — Assets, schedule and quick announce

**Depends on:** M6a.

- Asset store per §4.7: upload, thumbnails, serving at `/assets/<hash>`, and an asset picker form component.
- **Schedule:** the `cue.*` commands and a day-ordered cue list with CRUD.
- The `announcement` plugin (from M9), built on the public SDK only. It renders an opaque panel, so the interrupt modes `dim` and `show` are useful ([ADR 0008](docs/decisions/0008-interrupt-backdrop.md)).
- The `slideshow` plugin (from M9), so images reach the screen before M7's backgrounds.
- Quick announce: type a message in the Live panel, which creates an `announcement` instance and interrupts with it. The instance is kept in the library.

**Done when:** a complete show, including images and scheduled cues, can be built from scratch in the admin and runs unattended. A typed message can be announced in a few seconds.

The asset store, the asset picker, the `cue.*` rules, both plugins, quick announce and the pages are specified in [ADR 0011](docs/decisions/0011-assets-schedule-and-quick-announce.md).

### M7 — Theming

**Depends on:** M3; the admin UI part depends on M6b (forms and the asset picker, for fonts and image backgrounds).

- The theme model, commands and multiple themes with one active.
- Viewer: CSS custom properties, `@font-face` from uploaded fonts with `document.fonts.load()` gating, and background types (colour, image with dim, video, scene). Honours scene `background: "own"` and `Instance.background`. No background transition between two theme-background scenes. Optional `customCss`.
- The interrupt cover layer (`below: "hide"`) renders the same background as the bottom layer, not just its colour ([ADR 0008](docs/decisions/0008-interrupt-backdrop.md)).
- Admin theme editor with live preview, and activation.

**Done when:** switching the active theme live changes the background, fonts and colours of every built-in scene and overlay without a reload, and without a fallback-font flash.

Font faces, the `theme.*` rules, font gating, the background layer, scene backgrounds, the cover, custom CSS, video uploads and the admin pages are specified in [ADR 0014](docs/decisions/0014-theming.md).

### M8 — Overlays

**Depends on:** M3; the admin UI part depends on M6a.

- Slot layout per §4.5: flex stacks, order, gaps from the theme, safe area and max sizes.
- Fade out widgets for `reserveSlots` and `hideOverlays`, and stale-hide support in the SDK base class.
- Admin overlays page: a slot diagram, plus placing, reordering and toggling widgets.

- The `info` plugin's `clock` overlay (from M9), so overlays can be used in a real show.

**Done when:** two widgets stacked in `bottom-right` render correctly. A scene reserving `bottom-right` hides them during its run, and they return afterwards.

The commands, the slot grid, reservations, fading, the `staleAt()` hook, the clock and the pages are specified in [ADR 0012](docs/decisions/0012-overlays.md).

### M9 — Built-in plugins

**Depends on:** M2 and M3 at least; each plugin can be done individually as soon as its dependencies (M7/M8) exist.

Implement the plugins in §6.4 using only the public SDK, each with tests:

- `markdown` (polish the M2 fixture), `countdown` (scene and overlay), `info` (Wi-Fi with QR). `announcement` and `slideshow` are built in M6b, and `info`'s clock in M8.
- `now-playing` is deferred: it will be an external plugin in its own repository.

**Done when:** each plugin works in a real show, adapts to theme changes, and appears correctly in the admin with generated or custom forms.

Markdown rendering, plugin dependencies, the countdown, the Wi-Fi QR code and its editor, and the deferral of `now-playing` are specified in [ADR 0015](docs/decisions/0015-built-in-plugins.md).

### M10a — Resilience and show portability

**Depends on:** all of M0–M9.

- **Offline resilience.** A service worker caches the viewer shell, plugin modules and referenced assets. During an outage the viewer continues the rotation via `resolveTimeline` from its last state, and resyncs on reconnect.
- **Show export and import.** JSON plus an assets zip, for preparing a show ahead of the party.

**Done when:** a screen keeps playing through a network outage and a server restart and resyncs afterwards, and an exported show imports into a fresh install and plays the same.

**Deferred:** deployment, plugin authoring and the soak test (M10b).

The service worker, the stored state, the offline indicator and show files are specified in [ADR 0019](docs/decisions/0019-resilience-and-show-files.md).

### M10b — Operations and release

**Depends on:** M10a.

- **Deployment.** A systemd unit and an optional container image, published to GHCR as `ghcr.io/kwarf/storbild`, with a compose file and a Podman Quadlet unit. `docs/deployment.md` covers both ways of running the server, Caddy (two hosts, basic auth on screen), DNS, kiosk setup (`deploy/kiosk/`), and pinning or disabling Chromium updates.
- **Plugin authoring.** `docs/plugin-authoring.md` and a plugin template in `templates/plugin/`. Publish `@storbild/plugin-sdk` to npmjs, under the `storbild` npm organization, from tagged releases. Dev-mode reload of `STORBILD_PLUGIN_PATHS` (§6.3).
- **Soak test, last.** 24 h unattended on target-like hardware, set up from the docs, with a forced network outage and a server restart during the run.

**Done when:** a fresh VPS and kiosk can be set up from the docs alone, once with systemd and once with containers, and the soak test passes.

The package registries are specified in [ADR 0023](docs/decisions/0023-package-registries.md), container deployment in [ADR 0024](docs/decisions/0024-container-deployment.md), plugin reload in [ADR 0025](docs/decisions/0025-plugin-reload.md), the SDK build, releases and the template in [ADR 0026](docs/decisions/0026-sdk-publishing-and-plugin-template.md), and the kiosk in [ADR 0027](docs/decisions/0027-kiosk.md).

The split and the M10 items deferred by earlier ADRs are specified in [ADR 0016](docs/decisions/0016-split-m10.md).

---

## 10. Conventions for contributors and agents

- **Plan per milestone.** Before implementing, write a short plan for the milestone (the tasks, and any open questions it raises), and keep scope to that milestone.
- **Decisions.** Anything that changes or refines this document goes in `docs/decisions/NNNN-title.md` (context, decision, consequences), and this document is updated to match.
- **SQLite tables are `STRICT`.** Every table is created with `STRICT`, so column types are enforced. JSON columns are `TEXT` with a `CHECK (json_valid(col))` constraint.
- **Purity.** `packages/core` contains no I/O and no timers. Scheduling and sync logic must be unit-testable with injected time.
- **The SDK is a public API.** Keep its surface small. Breaking changes bump `apiVersion` and the SDK major version.
- **The server is the only writer.** Clients never mutate state directly; everything is a validated command.
- **One clock.** Never use `Date.now()` for scheduling in viewer or plugin code; use `serverNow()`.
- **Tests.** Every milestone adds tests for its acceptance criteria. Prefer tests at the boundary (the SSE stream, commands, `resolveTimeline`) over internal unit tests.

## 11. Open questions

None.
