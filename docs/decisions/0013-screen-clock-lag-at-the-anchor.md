# 13. Screen clock lag at the anchor

Date: 2026-10-11

## Status

Accepted

## Context

Commands that re-anchor the rotation (removing the item on air, ending a take or an
interrupt, other edits under ADR 0006) set `playlist.anchorAt` to the server's now. Before the
anchor, `resolveTimeline` has nothing on air. A screen resolves at its own `serverNow()`, which
can trail the server by a few milliseconds, or more with a poor clock estimate at the venue.
Such a screen briefly resolved "nothing on air", so the scene on air started to fade toward the
background before the next one came in. Commit aa2aa4b kept the outgoing scene fading under the
new one, which hid the pop but not the fade that starts and reverses.

## Decision

The compositor resolves with `resolveTimelineOnScreen(state, t)` in `packages/core`. When the
timeline at `t` has nothing on air, no live control is on air, and the anchor is at most
`ANCHOR_LAG_MS` (1 s) ahead of `t`, it resolves at the anchor instead. Otherwise it is
`resolveTimeline(state, t)`.

The server keeps resolving with `resolveTimeline`; its clock is the reference and it never
resolves before an anchor it has just set. Core's rotation semantics are unchanged.

## Consequences

- A screen whose clock trails by up to a second switches straight to the item at the anchor.
- A screen that trails by more still shows the gap until it reaches the anchor.
- Live control is untouched, so a screen behind the end of a take or interrupt keeps showing it.
  An anchor can only be ahead of the server's now while live control is on air.
