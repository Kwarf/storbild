# 19. Offline resilience and show files

Date: 2026-10-12

## Status

Accepted

## Context

M10a (DESIGN.md §9, ADR 0016) asks for two things:

- A screen that keeps playing through a network outage and a server restart, and catches up
  afterwards.
- A show that can be exported and imported into a fresh install, to prepare it before the
  party.

The compositor already resolves the timeline on its own (ADR 0006). So an open page keeps
rotating while the stream is down. Three gaps remained:

- **A reload during an outage.** A kiosk reboot, a browser crash or the watchdog can reload
  the page. The page, bundles and plugin modules can't then be fetched, and neither can the
  state, so Chromium shows its error page.
- **Content never loaded.** A plugin module or asset the screen hasn't loaded yet fails when
  its scene comes up during the outage. Examples are the next slideshow's images or a theme
  font.
- **The clock.** Without `/time`, a reloaded page's clock offset starts at 0.

A screen that keeps rotating also looks up to date when it isn't. Crew need to see that a
screen has lost the server, without the audience seeing an error.

The export format and the import rules were open too. ADR 0016 says "JSON plus a zip of the
assets". Bun has no zip API, and `Bun.Archive` builds tar archives in memory only, which won't
do for shows with video.

## Decision

### A service worker on the viewer app

`/sw.js` is served by the viewer app only.

- **Registration.** It is registered by the viewer page's entry (`@storbild/viewer/main`). The
  library export that the admin preview uses never registers it.
- **Secure context.** Service workers need a secure context, which is HTTPS or `localhost`. A
  screen on a plain-http LAN address runs as before, without offline starts.
- **The manifest.** The server builds the worker once per process as a classic script. In
  front of it, it puts a manifest, `self.__STORBILD__ = { version, precache }`. The manifest
  lists:
  - the page, `/`
  - every file of the viewer bundle, `/app/<hash>/…`
  - the vendor modules, `/vendor/<hash>/…`
  - every loaded plugin's modules, `/plugins/<id>/<version>/…`

  `version` is a hash of the list and the worker's code. The script therefore changes, and
  screens install the new worker, whenever any of them do. With the built-in plugins the
  precache is about 70 files and 700 KB.
- **Install and activate.** Install precaches the list into `storbild-<version>` and takes over
  at once. Activate deletes older precaches.
- **Strategies.** The worker answers each request by `route()` in `packages/viewer/src/offline.ts`:
  - **Passed through:** `/events`, `/time` and anything that isn't a GET. A cached answer can
    never pass for a live one.
  - **The page:** network first, with a 4 s timeout. It falls back to the cached copy when the
    network fails or is slow, and also on an error response, because Caddy answers 502 while
    the server restarts. A good response updates the copy.
  - **Bundles and modules:** cache first. Their URLs are versioned and immutable.
  - **`/assets/<id>`:** from the asset cache when there, else from the network. A `Range`
    request is answered with a `206` cut from the cached whole file, because `<video>` asks for
    ranges.
- **Which assets are cached.** The page tells the worker which asset URLs to keep: those
  `referencedAssetIds(state)` in core finds. These follow `assetUsers`' rules, so they are
  instance backgrounds and configs, and theme backgrounds and fonts. Files in the library that
  nothing uses are left out.
  - The page sends the list two seconds after each state change, including the snapshot after
    a reconnect.
  - The worker fetches missing files whole and one at a time, and deletes the files no longer
    wanted.
  - A file that fails to fetch is tried again with the next list.
- **Persistence.** The page asks for persistent storage, so the browser doesn't evict the cache.

### The last state and the clock

The viewer keeps `{ state, offsetMs, receivedAt }` in `localStorage` under `storbild:last`.

- It is written on each state, at most once a second, and when the page is hidden. Every
  access is guarded, and a stored value that doesn't validate against `showStateSchema` is
  ignored.
- On start, `ClockSync.seed(offsetMs)` sets the stored offset. The first successful sync slews
  from it, or snaps when it is far off.
- If no snapshot arrives within 3 s, the screen renders the stored state. The wait avoids a
  flash of old content on a normal start. The stream keeps trying meanwhile, and the next
  snapshot replaces the stored state as usual.

A screen reloaded during an outage therefore resolves the stored rotation at the server's
time, from cached modules and assets.

### The offline indicator

The compositor draws a pill in the bottom-right corner of the safe area: a dot and
"Offline · last update 14:32".

- **Placement.** It sits above overlays and the interrupt, and is hidden during blackout. It
  takes no overlay slot.
- **Look.** It uses the theme's surface colour at 80%, the muted colour and the body font, so
  it reads as part of the screen rather than an error.
- **The time.** It is the server time of the last message, or of the stored state, in the
  screen's time zone.

`OfflineTracker` decides when the pill shows:

- **Out of touch.** A screen is out of touch when no stream is open, or when an open stream has
  had no message for 20 s. The server pings every 15 s, so 20 s of silence catches a network
  drop the browser hasn't noticed. That silent stream counts as out of touch since its last
  message.
- **When it shows.** After 10 s out of touch, so a server restart doesn't flash it. A screen
  that started from its stored state shows it at once.
- **When it hides.** As soon as a stream is open and messages arrive.

The admin preview never sets the property. A per-screen "last seen" list in the admin would
let the operator see the same thing from the booth; it is left for later.

### Show files

A show file is one zip:

- `show.json`
- each asset at `assets/<sha256>`
- each thumbnail at `thumbnails/<sha256>.webp`

**`show.json`** is `showFileSchema` in core, with `format: "storbild-show"` and `version: 1`.

- **What it holds:**
  - plugin settings and versions
  - instances
  - playlist items
  - cues
  - overlay placements
  - themes and the active theme
  - settings
  - all asset metadata, including files nothing uses, because the library is part of
    preparing a show
- **What it leaves out:** runtime data. That is live control, the timeline, the revision,
  plugin and instance state, the rotation's anchor and resolved durations.
- **Newer files.** A file of a newer version is refused with a message saying so.

**The zip code is our own** (`packages/server/src/zip.ts`), with no dependency. ADR 0020
replaces it with zip.js; the reader's checks stay.

- **Writer.** It streams stored entries. It reads each file once for its CRC before writing it,
  so the sizes and CRC are in the local header and no data descriptors are needed, which every
  reader handles. It writes ZIP64 records only past 4 GiB.
- **Reader.** It works from the upload on disk. It takes stored and deflated entries, so a file
  zipped again by an OS tool still imports. It checks each entry's size and CRC, and stops an
  entry that inflates past its declared size.

**Export** is `GET /api/show/export`, an attachment named `storbild-show-<date>.zip`.

**Import** is `POST /api/show/import`, with the file as the raw body. It replaces the whole
show, and nothing changes unless all of these steps succeed:

1. The body is streamed to `<data>/tmp/`, up to `STORBILD_MAX_IMPORT_MB` (4096 by default).
   Bun's request limit grows to match, so `/api/commands` gets its own 1 MB limit.
2. The archive may hold only the entries above.
3. `show.json` must validate.
4. Each asset is stored by `AssetStore.ingest`, the upload path without registering. Its
   content must hash to its ID, and its type, size and dimensions are sniffed again. A
   thumbnail is kept if it sniffs as WebP and is at most 256 KB.
5. The host-only command `show.import` replaces the show in one revision. It runs
   `importShow` in core, which:
   - refuses files that refer to something they don't contain
   - resets live control
   - starts the rotation from its first item at the time of import
   - marks unfired cues whose time has passed as fired, so an old file causes no surprise takes
   - reconciles plugins, so instances of plugins this install lacks are kept, broken, with
     their plugin `missing`

Files stored for an import that failed, and files of the replaced show, are deleted. The
response lists the missing plugins.

The Settings page gains a "Show file" section:

- a download link
- a file picker
- a hold-to-confirm "Replace show" button
- a note to export the current show first

## Consequences

- A screen survives a reboot, a crash or a watchdog reload during an outage, and catches up on
  reconnect without a further reload.
- Screens on a plain-http address don't get offline starts. The deployment guide (M10b) should
  serve screens over HTTPS, as DESIGN.md §2 already does.
- Screens store every used asset, including videos. Kiosk disks are large, and the cache
  follows the show, so removed files are dropped.
- Chromium's offline emulation, which the e2e tests use, doesn't close a stream that is already
  open. The tests therefore stop the server to cut the stream, and use the emulation only
  around a reload.
- Importing replaces the show wholesale. A merge would need rules for ID clashes, the active
  theme and settings, and isn't needed to prepare a show.
- The SDK is unchanged.
- The deferred items are:
  - a per-screen "last seen" list in the admin
  - merging an imported show into an existing one
