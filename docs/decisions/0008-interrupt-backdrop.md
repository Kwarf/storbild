# 8. What shows beneath an interrupt

Date: 2026-10-11

## Status

Accepted. Replaces `dimBelow` from ADR 0006.

## Context

An interrupt has had a `dimBelow` flag, which laid a 60% black wash over the layers beneath
it. Scenes are transparent by default (DESIGN.md §4.6), so an interrupt with an ordinary
scene, such as a markdown instance, rendered its text straight over the frozen scene's text.
Manual testing of M5 showed this to be unreadable with or without the dim, and more dim
only helps so much. Only an interrupt that draws its own opaque panel works over live
content, and no such plugin exists yet (the `announcement` plugin is M9).

## Decision

`dimBelow: boolean` becomes `below: "show" | "dim" | "hide"` on `live.interrupt`, on
interrupt cues, and on `live.interrupt` and `timeline.interrupt` in state.

- **`hide` (the default)**: the compositor covers the layers beneath the interrupt (the main
  scene and the overlays) with the active theme's background. The interrupt then looks like
  an ordinary full-screen scene. The frozen scene stays mounted beneath, so it is still there,
  unchanged, when the interrupt ends.
- **`dim`**: a black wash over the layers beneath, now 75% instead of 60%. Meant for an
  interrupt that draws its own panel over live content.
- **`show`**: nothing beneath changes.

The cover is its own compositor layer, between the dim and the interrupt, and fades like the
others. Until M7 it uses the theme's background colour. M7 must render it with the same
background renderer as the bottom layer (image, video, scene).

A schema migration converts stored state: `dimBelow: true` becomes `"dim"` and `false`
becomes `"show"`, so existing live state and cues keep their look. New interrupts without
`below` get `"hide"`.

In the admin, the Announce row's "Dim below" checkbox becomes a select: Cover the screen,
Dim the screen, Over the screen.

## Consequences

- Any scene works as an announcement without dimming tricks. Over the screen and Dim the
  screen become useful once plugins draw announcement panels.
- An interrupt now differs from a take by covering the overlays and pausing the rotation,
  not by how it looks.
- The API breaks for anyone sending `dimBelow`. That was only possible since M4 and before
  any release, so `dimBelow` is not accepted as an alias.
