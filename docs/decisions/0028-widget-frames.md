# 28. Widget frames

Date: 2026-10-15

## Status

Accepted. Refines ADR 0012 (overlays) and ADR 0014 (theming).

## Context

Each overlay widget draws its own box today: the clock, the Wi-Fi card and the countdown widget
each hardcode a padding, an 8 px radius and an opaque `--sb-color-surface` background. The
theme supplies only the colour, so the widgets look like separate rectangles pasted on the
screen rather than one set, and a third-party widget matches only if its author copies the
same values.

We tried frames in the demo show over a soft gradient and over a busy line-art image: solid,
translucent with a backdrop blur ("glass"), and no box at all with a text shadow, and then
opacity, blur and shadow variants of glass. Glass with an 8 px blur at about 55% opacity kept
text readable over the busy image and tied the widgets to the background. A bare text shadow
lost to busy backgrounds. A light inner line along the top edge lifted the cards without
adding clutter. Outer shadows were cut off by the slots' `overflow: hidden`.

## Decision

**The compositor draws the frame.** The wrapper `OverlayLayer` puts around each widget
(`.widget`) gets the padding, border, radius, background, backdrop filter and shadow, like the
compositor already owns layers and transitions. Widgets render their content on a transparent
host and inherit `color` from the frame. Built-in widgets drop their own boxes.

**An overlay type can opt out.** `InstanceTypeDefinition` and `PluginTypeInfo` gain
`frame?: boolean`, default `true`. With `frame: false` the wrapper draws nothing, for widgets
that bring their own shape, such as a full-width ticker. Scenes ignore it.

**The theme configures it.** `Theme` gains an optional `widgets` object; every field is
optional and has a default, so existing themes and show files keep working:

```ts
widgets?: {
  style?: "glass" | "solid" | "none";        // default "glass"
  opacity?: number;                          // glass only, 0–1, default 0.55
  blur?: number;                             // glass only, px, 0–64, default 8
  radius?: number;                           // px, 0–64, default 20
  shadow?: "none" | "soft" | "deep" | "glow"; // default "soft"
}
```

- `glass`: the surface colour at `opacity`, `blur(<blur>px) saturate(140%)` behind it, a 1 px
  border of the text colour at 18%, and a 1 px inner highlight along the top edge.
- `solid`: the opaque surface colour, no border, no blur.
- `none`: no box and no padding. Text gets a dark shadow instead, and `shadow` is ignored.
- `soft` is one shadow at 35% black, `deep` two at up to 60%, and `glow` the accent colour at
  35%, spread evenly.

The viewer turns these into `--sb-widget-padding`, `--sb-widget-border`,
`--sb-widget-radius`, `--sb-widget-background`, `--sb-widget-backdrop`, `--sb-widget-shadow`,
`--sb-widget-text-shadow`, `--sb-widget-shadow-margin` and `--sb-widget-clip-margin` in
`themeVariables`, which
are the only place the defaults live: the compositor shows no widget before a theme is applied,
so its CSS has no fallbacks. These variables are not part of the plugin
API: plugins should not read them, and `customCss` may override them at its own risk.

The Theme page gets a "Widgets" group with the five fields. The style and shadow are selects,
and the opacity and blur fields only apply to glass.

**Widgets clip themselves, slots clip with a margin.** A widget larger than its slot's cap
(ADR 0012) shrinks to the cap and is clipped inside its own frame: the wrapper has
`overflow: clip`, `min-height: 0`, and in `top` and `bottom` a `max-height` of the cap. The
style `none` gives that clip a 16 px margin, through `--sb-widget-clip-margin`, so its text
shadow isn't cut. Content therefore never reaches past its slot. `.slot` changes from
`overflow: hidden` to `overflow: clip` with `overflow-clip-margin:
var(--sb-widget-shadow-margin)`, which is 0 for the shadow `none`, 32 px for `soft`, 48 px for
`glow`, 64 px for `deep`, and 16 px for the style `none`, so a frame's shadow can spill into the
gap and the safe area.

## Consequences

- All widgets match by construction, including third-party ones, and one theme setting
  changes them all.
- `frame` is an additive SDK field, so `apiVersion` stays at 1 and the SDK gets a minor
  version bump. Existing overlays that draw their own box get a second frame around it until
  they drop it or set `frame: false`. The only external widget so far is maintained alongside
  Storbild and is updated with this change.
- The safe area may hold decoration (shadows), never content. On a projector that overscans,
  the edge of a shadow may be lost, which is harmless.
- An oversized widget is cut off inside its frame rather than at the slot's edge, so it stays a
  whole panel. Several widgets that together overflow a capped slot all shrink, rather than
  the last one being cut off.
- Backdrop blur costs GPU time on the kiosk. Glass with `blur: 0` and a high opacity, or
  `solid`, is the fallback for weak hardware.
- While the overlay layer fades (it uses `opacity`), browsers can't sample the backdrop
  through it, so the blur drops out for the length of the fade.
- Browsers without `overflow-clip-margin` (Safari, used for the admin preview at most) clip
  shadows at the slot edge.
