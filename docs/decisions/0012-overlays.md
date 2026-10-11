# 12. Overlays

Date: 2026-10-11

## Status

Accepted

## Context

M8 (DESIGN.md §9) puts overlay widgets on the screen. §4.5 fixes the slots and the placement
model, and type infos already carry `reserveSlots` and `hideOverlays`. These questions were
left open:

- What the `overlay.*` commands take, and how the order inside a slot is kept.
- How the slots are laid out, in particular the bars against the corners.
- Where the gap between widgets comes from. §4.6 lists `--sb-gap` but `Theme` has no field
  for it.
- Which scenes' reservations count, and how a hidden widget leaves its stack.
- How a widget says that its data is stale.
- What M8 shows on a real screen. All the built-in overlays (`countdown`, `info`,
  `now-playing`) were planned for M9.

## Decision

**Commands.**

- `overlay.place { instanceId, slot, index?, visible? }` places an instance of an overlay type.
  It is `422` for any other kind, for an instance whose plugin isn't loaded, and for an instance
  that is already placed, since each instance is placed at most once. `visible` defaults to
  true, and the widget is appended to the slot unless `index` is given.
- `overlay.update { instanceId, slot?, index?, visible? }` moves a placement within its slot or
  to another one, or shows or hides it. Without `index` it keeps its position in its own slot,
  or is appended to a new one. It is `404` when the instance isn't placed.
- `overlay.remove { instanceId }`.

The reducer renumbers every slot after each change, so `order` runs 0..n-1 in each slot and is
the only ordering that matters. It keeps `overlays` sorted by slot and order, so an edit to one
slot never moves another slot's entries in the patch. A placed instance that later breaks stays
placed. The viewer skips it and the admin flags it. Deleting an instance still removes its
placement (§5.3).

**Layout.** Inside the safe area, the overlay layer is a grid of five rows:

| Row | Content |
|---|---|
| 1 | `top-bar`, full width |
| 2 | `top-left`, `top`, `top-right` |
| 3 | `left`, the empty centre, `right` |
| 4 | `bottom-left`, `bottom`, `bottom-right` |
| 5 | `bottom-bar`, full width |

So the bars push the corners in and never overlap them.

Each slot is a flex stack toward the centre, and order 0 is nearest the edge:

- Corners, `left` and `right` stack vertically, aligned to their side. The bottom ones use
  `column-reverse`.
- `top` and `bottom` stack horizontally, centred.
- Bars stack vertically and stretch.

The caps are fixed in the compositor and not configurable:

- corners, `left` and `right`: at most 640 px wide
- `top`, `bottom` and the bars: at most 240 px high

Anything larger is clipped.

**Theme values.** The compositor sets `--sb-safe-area` (the theme's `safeArea`, default 96 px,
the fallback the plugins already use) and `--sb-gap` on its root. `Theme` gains an optional
`gap` in px, default 24. M7 adds the other theme variables and the editor, so M7 and M8 don't
depend on each other.

**Reservations.** The slots that fade out are the union of the `reserveSlots` of the resolved
`main` and `interrupt`, or every slot when either has `hideOverlays`. The interrupt counts
because with `below: "show"` the overlays stay visible beneath it. The compositor computes this
with `reservedSlots(state, timeline)` in core from its own `resolveTimeline` result, so widgets
fade at `startsAt` together with the scene change. Blackout covers everything anyway.

**Fade and collapse.** A widget is shown when four things hold:

- it is placed and `visible`
- it is renderable and of an overlay type
- it isn't stale
- its slot isn't reserved

Hiding a widget fades its wrapper out over `settings.transitionMs`, then sets `display: none`,
so the rest of the stack closes the gap. Showing it reverses that. The gap closes in one step
when the fade ends; animating it is left for later. Widgets are keyed by instance and stay
mounted while they are only reserved or stale, so a scene change never reloads them. Hiding or
removing a placement in the admin unmounts the widget after its fade. `prepare()` is awaited
before the first fade-in. The compositor calls `enter` and `exit` on each fade-in and fade-out,
and `dispose` on unmount.

**Stale-hide in the SDK.** `StorbildOverlay` gets an optional `staleAt(): number | undefined`
hook, which returns the server time at which the widget's data becomes stale (`undefined` means
never). The base class checks it on every update, sets a reflected `stale` property, and arms
a timer for that time using `ctx.serverNow()`. When `stale` changes it fires a bubbling,
composed `sb-overlay-stale` event (`STALE_EVENT`), which the compositor uses to fade the widget
and close the gap. A widget whose data comes from a server part, such as now-playing, typically
returns the time of its last update plus a timeout.

**The `info` plugin's clock comes forward from M9.** That way overlays can be used in a real
show from M8, as M6b brought forward `announcement` and `slideshow`. `info/clock` is an
overlay that shows `serverNow()` as 24-hour time:

- Its config is `seconds` (default false).
- The plugin's settings take an optional IANA `timeZone`. Without one, or with an unknown one,
  it uses the screen's own zone.
- It redraws when the shown minute or second changes and uses the theme variables and
  `tabular-nums`.
- The `wifi` overlay, which needs a QR code, stays in M9.

**The admin.**

- **Overlays page:**
  - A diagram of the ten slots listing their widgets, with the slots reserved by what is on air
    drawn dashed. Selecting a slot makes it the target for placing.
  - The placed widgets as rows grouped by slot. Each row has a visibility toggle, a slot
    select, move toward the edge or centre, and remove. Rows can be dragged within and across
    slots, and onto the diagram.
  - A bar to place an unplaced overlay instance in a slot.
- **Library:** the instance list and the new-instance type picker are split into Scenes and
  Overlays (and Unavailable, for instances whose plugin is gone), then grouped by type. It
  previews an overlay alone in its slot, or in `bottom-right` while it isn't
  placed. Scene previews no longer show the placed overlays, so the preview shows only the
  instance being edited.
- **Strip:** the Overlays row leaves out widgets in reserved slots.

## Consequences

- The plugin API grows without breaking: `staleAt()`, `stale` and `STALE_EVENT` on the
  `/viewer` subpath. `apiVersion` stays at 1. The SDK is not published yet, so its version
  isn't bumped.
- Widgets size themselves, so a widget wider or taller than its slot's cap is clipped rather
  than scaled.
- The stale check runs in the viewer from the widget's own data, so the server needs no
  timers for it, and a viewer that is offline hides stale widgets on its own.
- M9 shrinks by the clock. `countdown`'s overlay, `info/wifi` and `now-playing` build on the
  slots and `staleAt()`.
