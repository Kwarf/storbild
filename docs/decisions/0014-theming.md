# 14. Theming

Date: 2026-10-11

## Status

Accepted. Refines ADR 0008 (the interrupt cover) and ADR 0011 (the upload route, theme cues).

## Context

M7 (DESIGN.md §9) gives the show a party-wide look. The `Theme` schema, `themes` and
`activeThemeId` in state, their table and `activateTheme` cues have existed since M1 and M6b.
These questions were left open:

- What the `theme.*` commands take, and what deleting a theme does to cues that activate it.
- `FontRef.assetIds` lists woff2 files but not which weight or style each one is.
- How fonts are declared and loaded so that no fallback font is ever shown.
- How the interrupt cover renders "the same background as the bottom layer" (ADR 0008)
  without a second video or WebGL context.
- Where `customCss` applies, and how the admin preview avoids it leaking into the admin.
- Video backgrounds need video uploads, which M6b left out.
- Whether plugins need theme access in `ctx`.

## Decision

**Fonts.** `FontRef` becomes `{ family, faces?: { assetId, weight, style }[] }`:

- `weight` is 1–1000, default 400.
- `style` is `normal` or `italic`, default `normal`.
- Without `faces`, `family` is a font stack the screens have, such as `sans-serif`. With
  faces, it is only a name for the operator.

A database migration turns each stored `assetIds` entry into a regular face (400, normal).

**Commands.**

- **`theme.create`** takes a name and any of `background`, `fonts`, `colors`, `safeArea`,
  `gap` and `customCss`. Missing parts are the default theme's values. It returns the new
  theme's `id`.
- **`theme.update`** takes `{ id, … }`. `background`, `fonts` and `colors` are replaced whole,
  and `null` clears `safeArea`, `gap` or `customCss`.
- **Validation (`422`).** Every file a theme uses must exist and be of the right kind:
  - an `image/*` for an image background
  - a `video/*` for a video background
  - `font/woff2` for a face

  A scene background must be a scene instance. An unknown file or instance is `404`.
- **`theme.delete`** refuses the active theme (`422`). It also removes the unfired
  `activateTheme` cues for that theme in the same revision, as deleting an instance removes
  its cues (§5.3). Fired cues stay as history.
- **`theme.activate`** takes `{ id }`. Unknown IDs are `404` for every theme command.
- **Missing active theme.** On load, if the active theme is missing, the server activates the
  first stored theme, or creates a default one. So the screen always has a theme.

**Variables and font gating.**

- The compositor sets the theme's CSS custom properties on its host element (DESIGN.md
  §4.6). They inherit into every plugin's shadow DOM. `--sb-font-mono` falls back to
  `monospace`.
- Uploaded faces are added to `document.fonts` with the FontFace API rather than static
  `@font-face` rules. This works the same in the viewer and in the admin's previews.
- Each set of faces is registered under its own family name: `sbf-` plus a short hash of the
  files, weights and styles. Two themes, or a theme and the admin's own font, never mix their
  files.
- The compositor applies a theme only once its faces have loaded, or after 5 s, so a broken
  file can't hold the screen. "Applies" covers the variables, the background and the custom
  CSS, which switch together.
- Until a new theme's fonts are ready, the previous theme stays on screen. Before the first
  theme is ready, nothing is drawn, so no fallback font is ever shown.

**Backgrounds.** A background layer renders the theme background, keyed by kind and file:

- **`color`:** a colour that fades by CSS when it changes.
- **`image`:** `object-fit` from `fit`.
- **`video`:** a muted, looping, inline `<video>` that fills the screen.
- **`scene`:** the instance, through its own `SceneLayer`.

Image and video have an optional black wash at opacity `dim`. A background with the same key
is updated in place. So two themes with the same image don't flicker, and two consecutive
theme-background scenes never transition the background. A new background fades in over the
old one once it is decoded or can play, and the old one is removed after the fade.

**Scene backgrounds.** `sceneBackground(state, instanceId)` in core says what a scene shows
behind itself:

- its instance's `background` when set
- else `none` for a type with `background: "own"`
- else `theme`

When the resolved main scene's background is anything but `theme`, the theme background layer
fades out. An instance's own image background (`{ assetId, fit }`) is drawn in its scene
wrapper, beneath the element, so it crossfades with the scene. `none` leaves black.

**The interrupt cover (refines ADR 0008).** With `below: "hide"`, the compositor no longer
draws a second copy of the background. It fades the main scene and overlay layers out and the
theme background layer back in, even under a scene with its own background. The frozen scene
stays mounted. The cover is therefore the same background, with no duplicated video or WebGL
context. `dim` and `show` are unchanged.

**Custom CSS.** `customCss` is an adopted stylesheet in the compositor's shadow root, after
its own styles. It reaches:

- the layers
- inherited properties
- the `::part`s that plugins expose

It never reaches the page around an admin preview. CSS that fails to parse is logged and
ignored.

**Video uploads, streamed (refines ADR 0011).** A video can be hundreds of MB, so no upload is
held in memory any more.

- **`POST /api/assets?name=…` takes the file as the raw request body**, replacing ADR 0011's
  multipart fields. The store streams it to a temporary file in the assets directory while
  hashing it, then renames it to its SHA-256. Memory use stays at one chunk whatever the size.
- **The type is judged from the first 256 KB**, which also picks the limit. Anything but a
  video is read back whole once stored, for image sizes that lie further in.
- **Limits.** Videos have their own, `STORBILD_MAX_VIDEO_UPLOAD_MB` (default 200), and other
  files keep `STORBILD_MAX_UPLOAD_MB`.
  - A `Content-Length` over the larger one is refused at once.
  - Otherwise the upload is cut off as soon as it passes its type's limit, and its temporary
    file is deleted.
  - The admin server's `maxRequestBodySize` is raised to match, since Bun refuses bodies over
    128 MB by default.
- **The thumbnail is a second request**, `PUT /api/assets/<id>/thumbnail`, with the WebP as
  the body (at most 256 KB, sniffed as before). It sets the asset's `thumbnail` flag through the
  new host command `asset.setThumbnail`, so a file shows without a thumbnail until it arrives.
- **Formats.** MP4 (an `ftyp` box with a common MP4 brand) and WebM (EBML with DocType `webm`)
  are accepted.
- **Serving.** Assets are served with HTTP Range support, which `<video>` needs. Bun answers
  Range requests for file responses.
- **Video thumbnails.** The admin makes them from a frame about a second in.

**No theme in `ctx`.** The theme API for plugins is the set of CSS variables. A scene that
needs a colour in script, such as a WebGL background, reads it with `getComputedStyle`. The
SDK surface is unchanged and `apiVersion` stays at 1.

**The admin.**

- **Theme page:** the stored themes as rows, with the active one marked. The editor beside
  them has:
  - a name
  - a background type with its fields
  - the colours
  - the fonts, each with its face rows (a file, a weight and a style)
  - the safe area and widget gap
  - the custom CSS
  - Save, Revert, Activate, Duplicate and Delete

  The form is built from SDK `Field`s rather than generated from the schema, because a
  generated form would show the background union as raw JSON.
- **Theme preview:** the live show with the draft as its active theme. When nothing is on air
  it shows a sample markdown scene. The preview stays in view beside the form on wide
  screens.
- **Library:** a scene's editor gets a Background control: the type's default, the theme's
  (for `own` types), none, or an image.
- **Schedule:** cues can switch the theme, which ADR 0011 left read-only until M7.
- **Asset picker:** a file without a picture, such as a font, shows its format instead of a
  broken thumbnail.
- **Placeholders:** the SDK's `Field` gains an optional `placeholder`, shown in empty text,
  number and duration inputs. The Layout fields use it for the defaults they fall back to (96
  and 24), rather than spelling them out in the description.

## Consequences

- A theme switch can lag the patch by the time its fonts take to load, at most 5 s. Every
  screen shows the old theme rather than a fallback font in the meantime.
- Static `@font-face` rules in the viewer page are not needed, and DESIGN.md §4.6 says so.
- `.cover` is gone from the compositor. `.main.off` and `.overlays.off` mark the covered
  layers, and `.background.off` marks a scene with its own background.
- Scene elements are now absolutely positioned in their wrapper, so an instance background
  can sit beneath them. Plugin elements that fill their host are unaffected.
