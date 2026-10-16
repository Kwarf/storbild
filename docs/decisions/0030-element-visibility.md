# 30. Element visibility

Date: 2026-10-16

## Status

Accepted. Refines ADR 0005 (the viewer), ADR 0012 (overlays) and ADR 0014 (theming).

## Context

A WebGL shader scene, used as a theme background (`{ type: "scene" }`, ADR 0014), is meant to
keep the GPU busy every frame. The compositor often keeps an element mounted while it can't
be seen:

- the theme background fades out (`.background.off`) while a scene with its own background
  is on air, and comes back afterwards
- under an interrupt with `below: "hide"`, the main scene and overlays fade out but stay
  mounted, so the frozen scene can come back
- a blackout covers every layer
- the next scene is prefetched, mounted at opacity 0 and prepared, before its `enter`
- an overlay widget fades out but stays mounted while its slot is reserved or it is stale

None of these are visible to the element. It can't tell opacity on an ancestor across shadow
roots, and `IntersectionObserver` doesn't see opacity. A shader behind an opaque layer keeps
rendering at full cost, which matters on kiosk hardware such as a Raspberry Pi. The same goes
for the theme's own background video, which keeps decoding while its layer is off.

## Decision

**A `visible` property on `StorbildElement`.** The SDK's base class gets a reactive Lit
property, `visible: boolean` (`attribute: false`), next to `config`, `settings` and `ctx`. The
compositor sets it on scenes and overlays alike. A plugin reacts to it like any other
property, in `willUpdate` or `updated` (`changed.has("visible")`), for example by stopping its
`requestAnimationFrame` loop. It is a property rather than a pair of lifecycle methods
because it toggles many times in an element's life, and it fits how Lit elements already get
their data.

**What it means.** `visible` is `true` while any of the element may be on screen, fades
included, and `false` while it is mounted but fully hidden:

- before `enter`: a prefetched or preparing scene, and a widget being prepared
- under a hidden layer: the theme background behind a scene with its own background, the main
  scene and overlays under an interrupt's `hide`, and every layer under a blackout
- a widget faded out because its slot is reserved or it is stale

The compositor doesn't judge what a scene draws, so a scene under an opaque interrupt with
`below: "show"` stays `visible`. Off-screen documents (a hidden tab, an admin preview scrolled
out of view) are not covered either: browsers already throttle `requestAnimationFrame` in
hidden documents, and a plugin may add its own `IntersectionObserver`.

**When it changes.**

- It becomes `true` before the element starts to fade in: before `enter(at)` for a scene,
  before the layer's fade for a layer coming back. So an element that resumes on `visible`
  has a fresh frame for the whole fade.
- It becomes `false` only once the fade-out has finished, after the layer's fade (the show's
  `transitionMs`) or the widget's. A layer that comes back during the fade cancels the change.
- The host sets it to `false` before the element is connected. It stays `undefined` on hosts
  older than this change, since the base class comes from the host's SDK through the import
  map, so plugins treat anything but `false` as visible (`this.visible !== false`).
- An outgoing scene stays `visible` until it is disposed.

**The layers compute it.** The compositor tells each layer whether it is shown:

- background: not `ownBackground && !covered`, and no blackout
- main and overlays: not `covered`, and no blackout
- interrupt: no blackout

`SceneLayer` combines that with each scene's phase, and `OverlayLayer` with each widget's
fade state. The delay before `false` is a timer per layer, since the layers fade by CSS
transition.

**The theme video pauses too.** `BackgroundLayer` pauses its `<video>` when its layer has been
hidden for the length of the fade and plays it again when the layer is shown. A theme video
is a loop that isn't synced across screens, so where it resumes doesn't matter.

## Consequences

- An additive SDK field, so `apiVersion` stays at 1 and the SDK gets a minor version bump.
  Existing plugins ignore the property and keep working.
- A plugin built against the new SDK can run on an older host and then never sees `visible`,
  so it must not wait for it to become `true` before it renders.
- A shader or other animated plugin costs nothing while it is hidden, including a frozen scene
  under an interrupt and the theme background behind a slideshow.
- Built-in plugins don't need it: they redraw on occasional timers set from `serverNow()`, which
  cost little while hidden. They can adopt it later.
- `visible` is about the compositor's layers only. A plugin that needs to know about a hidden
  page or a preview out of view still checks for that itself.
