# Changelog

What changed in each Storbild release, for the people who run it: the server, the screens and
the admin. A release that needs something done before or after upgrading starts with
**Upgrading**. Changes that affect plugin authors are in the
[SDK changelog](packages/plugin-sdk/CHANGELOG.md), and linked from here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [semver](https://semver.org/). Each release is a `v<version>` tag and the image
`ghcr.io/kwarf/storbild:<version>`.

## Unreleased

## 1.2.0 — 2026-10-16

### Added

- A **Shader** scene: paste a fragment shader from Shadertoy's Image tab, or open it from a
  file, and use it on air or as the theme background. Every screen shows the same frame, the
  theme colours are available to the shader, and the Library checks that it compiles and
  shows the errors by line. If an edit doesn't compile, the screens keep the last version that
  did. **Resolution** and **Frame rate limit** keep heavy shaders within what a slow screen
  can draw ([ADR 0031](docs/decisions/0031-shader-plugin.md)).

### Changed

- A theme's background video pauses while it can't be seen, behind a scene with its own
  background or under a blackout, and plays again when it comes back.
- Screens tell plugins when their scenes and widgets are hidden, so animated ones can stop
  drawing ([ADR 0030](docs/decisions/0030-element-visibility.md), see the
  [SDK changelog](packages/plugin-sdk/CHANGELOG.md#120--2026-10-16)).

## 1.1.0 — 2026-10-15

### Upgrading

- Overlay widgets look different: the screens now draw every widget in a see-through, blurred
  panel with a soft shadow. To get close to the old look, set **Frame** to *Solid* under
  **Widgets** on the Theme page.
- On a slow screen, such as a Raspberry Pi with a video background, the blur behind widgets
  may cost frame rate. Set **Blur** to 0, or the frame to *Solid*.
- External plugins with overlay widgets need an update to drop their own box, or they show a
  box inside the frame. See [SDK 1.1.0](packages/plugin-sdk/CHANGELOG.md#110--2026-10-15).

### Added

- **Widgets** settings on the Theme page: the frame around overlay widgets (glass, solid or
  none), its opacity, blur and corner radius, and its shadow (none, soft, deep or a glow in the
  accent colour) ([ADR 0028](docs/decisions/0028-widget-frames.md)).

### Changed

- The screens draw the frame around overlay widgets, so all widgets match, including those
  from external plugins. The built-in clock, Wi-Fi, countdown and Markdown widgets no longer
  draw their own boxes.
- A widget too large for its slot shrinks to the slot and is clipped inside its frame, instead
  of being cut off at the slot's edge.

## 1.0.0 — 2026-10-13

The first release.

### Added

- One server with two ports: the screens' viewer and the password-protected admin. Screens
  render the show themselves from synced state and keep playing through network and server
  outages.
- A rotation of scenes, a schedule of timed cues, and live control: take a scene, interrupt
  with an announcement, black out.
- Overlay widgets in fixed slots around the screen, themes with uploaded fonts and
  backgrounds, and an asset library for images, video and fonts.
- Built-in plugins: Markdown text and widgets, slideshows, countdowns, announcements, and a
  clock and Wi-Fi widget. External plugins are written with `@storbild/plugin-sdk`.
- Show files: export and import a whole show as one zip, which is also the backup.
- A container image for amd64 and arm64, Caddy, compose and Quadlet files, and a kiosk setup
  for the screens ([docs/deployment.md](docs/deployment.md)).
