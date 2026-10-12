# 11. Assets, schedule and quick announce

Date: 2026-10-11

## Status

Accepted. The upload route's body and thumbnail are refined by ADR 0014.

## Context

M6b (DESIGN.md §9, ADR 0009) completes the admin. It adds uploaded files, timed cues, an
announcement plugin and a quick announce from a typed message. That raised these questions:

- How files are identified, checked and served, and where thumbnails come from. The server has
  no image library, and a native one such as sharp would complicate deployment.
- How a plugin's config refers to a file, and how the admin's form picks one, including in a
  custom editor.
- What may be deleted while something still uses it.
- The rules for the `cue.*` commands, which ADR 0006 deferred.
- How images reach the screen at all. M6b's "done when" needs images on screen, but the
  `slideshow` plugin was planned for M9, and per-instance and theme backgrounds belong to M7.
- Whether quick-announce instances are kept or cleaned up (DESIGN.md §11).

## Decision

**An asset is identified by its content.** The ID is the lowercase hex SHA-256 of the file.
`AssetMeta` gains an optional `thumbnail` flag; its other fields are unchanged. Uploading the
same file again changes nothing: it keeps its first name and time.

**Uploads go through one admin route.** `POST /api/assets` takes multipart fields:

- `file`
- `name` (optional)
- `thumbnail` (optional)

It is under `/api/`, so it needs a session and a matching `Origin` like everything else there.
The route stores the file, then registers it with the host-only command `asset.add`, so the
server stays the only writer and viewers get a patch. It answers `200` with the `AssetMeta`,
`413` above the limit, and `415` for a type that isn't allowed.

- **The type is sniffed from the content**, never taken from the name or the declared type. The
  allowed types are:
  - PNG, JPEG, GIF, WebP and AVIF
  - SVG, accepted when its root element is `<svg>` after an optional XML prolog, comments and
    an SVG doctype
  - woff2, for M7's fonts
  - Video waits for M7, which also needs Range requests.
- **The server reads an image's width and height from its header**, in plain TypeScript
  (`sniff.ts`). For SVG it uses `width`/`height` in px, else the `viewBox`. ADR 0021 replaces
  the parsing with file-type and image-size.
- **The limit is `STORBILD_MAX_UPLOAD_MB`**, 25 by default.
- **Thumbnails are made by the admin.** It draws a WebP of at most 320 px on a canvas and sends
  it with the file. The server keeps it only if it sniffs as WebP and is at most 256 KB.
  Otherwise the admin shows the file itself, so a browser without WebP encoding loses nothing
  but bandwidth.

**Files live in the data directory.** They are stored under `assets/<id>`, with thumbnails at
`assets/thumbs/<id>.webp`. Metadata is in an `assets` table (`id`, JSON `data`, `STRICT`).

- A file is written to a temporary name and then renamed, so a file under its hash is always
  complete.
- On start, the store deletes files the show doesn't know, such as those of an interrupted
  upload.
- When an asset leaves the show, its files are deleted.

**Assets are served immutably on both apps.** `GET /assets/<id>` is served on the viewer app and,
for the preview, on the admin app. Only assets in the show are served, with:

- the stored type
- `Cache-Control: public, max-age=31536000, immutable`
- `nosniff`
- `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, so an
  upload opened directly, an SVG for example, can never run as a page of the origin

`GET /assets/<id>/thumbnail` is served on the admin app only.

**Plugins refer to files by ID.** `fields.asset({ accept? })` is a string that must be an asset
ID, tagged with the widget `asset`, and optionally `x-storbild-accept` with MIME patterns such
as `image/*`. The form model has an `asset` field kind, and a list of assets is a normal list. A
viewer gets the URL from `ctx.assetUrl(id)`, which already existed.

**The picker gets the assets from the admin through an event.** `<sb-field>` renders an `asset`
field as the SDK's `<sb-asset-picker>`, which:

- shows the chosen file
- lists matching files to choose from
- uploads a new one

On connecting, the picker fires a bubbling, composed `sb-asset-source` event, and the admin shell
answers by setting `detail.source` to an `AssetSource` (`list`, `url`, `previewUrl`, `upload`,
`subscribe`). A custom editor that uses `<sb-field>` therefore gets the picker with no property
to pass down, and the SDK has no global. Without a source, the picker shows the ID read-only.

**Nothing in use can be deleted.** `asset.delete` is `422` while `assetUsers(state, id)` finds a
user, and the message names the users. A user is any of these:

- an instance whose `background` is the asset
- an instance whose config contains the ID as a string anywhere. Asset IDs are hashes, so an
  exact match needs no schema.
- a theme whose background or fonts use the asset

`asset.update` renames an asset. Replacing an asset (§4.7) is deferred until it is needed.

**Cue commands.** `cue.create { at, action }` returns the new cue's `id`. `cue.update { id, at?,
action? }` replaces the action whole. `cue.delete { id }` removes a cue.

- `at` must be after the command's time (`422`). A cue in the past would fire at once, as of
  its `at` (ADR 0006), which is never what an operator setting a time means.
- A take or interrupt needs a playable scene, as `live.*` does. `activateTheme` needs an
  existing theme (`404`).
- A fired cue can't be updated (`422`); it can only be deleted. There is no command to re-arm a
  cue: add a new one.

**`slideshow` moves from M9 to M6b,** so images reach the screen without pulling M7's
backgrounds forward. It has one scene type, `images`:

- **Config:** `images` (at least one, `image/*`), an optional `perImageMs`, and `fit`
  (`cover` or `contain`).
- **Settings:** `perImageMs`, 8 s by default.
- **Duration:** the number of images times the time per image.
- **Background:** `own`.

The image on screen is worked out from server time since the scene entered, so every screen
shows the same one. Images that fail to load are skipped.

**The `announcement` plugin** has one scene type, `announcement`. Its config is a `message`,
shown as plain text line by line, an optional `title`, and a `tone` (`info` or `urgent`). It
draws an opaque panel in the theme's surface colour and shrinks the text until it fits. It
declares no duration: interrupts and takes set their own.

**Quick announce keeps its instances.** In the Live panel, a typed message creates an
`announcement` instance named after the message's first line (shortened to 40 characters), then
interrupts with it. The instance stays in the Library like any other, and the Live panel's
picker lists announcements first, so a message can be announced again or scheduled. The
operator deletes old ones when they like. This answers DESIGN.md §11.

The Announce section switches between a message and an instance, and has one duration, one
backdrop choice and one Announce button for both. Ctrl+Enter in the message announces it. Without
the announcement plugin, only an instance can be announced. The backdrop default stays `hide`,
as in ADR 0008, rather than a separate default for typed messages.

**The pages.**

- **Schedule:**
  - Cues grouped by local day and ordered by time, as dense rows. Each row shows the time, how
    far away it is, the scene, the action, and a status badge (next, fired, or broken).
  - An add form with a time (to the second), take or interrupt, the scene, a duration and the
    backdrop.
  - Inline editing of a cue that hasn't fired, removal, and "Remove fired".
  - `activateTheme` cues are shown read-only until M7 adds themes.
- **Library:** a Files group under the instance groups, with an Upload button. A file's panel
  shows a preview, its details and what uses it, renames it, and deletes it once nothing does.

## Consequences

- The plugin API grows without breaking: `fields.asset`, `ACCEPT_KEY`, and in the `/admin`
  subpath `AssetSource`, `ASSET_SOURCE_REQUEST`, `accepts` and `<sb-asset-picker>`.
  `apiVersion` stays at 1.
- The server stays free of native dependencies. Thumbnails depend on the uploading browser,
  which is acceptable for a single trusted operator.
- `assetUsers` matches IDs as strings, so a config that happens to contain an asset's hash for
  another reason would keep that asset from being deleted. With 64-character hashes this
  doesn't happen in practice.
- M9 shrinks by `slideshow`. M7's theme editor can use the asset picker for fonts and image
  backgrounds.
