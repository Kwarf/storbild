# 6. Scheduler and timeline

Date: 2026-10-11

## Status

Accepted

## Context

M4 (DESIGN.md §9) asks for a pure `resolveTimeline(state, t)` in core, server-side durations,
cue firing and a server timer, the `live.*` commands, and a viewer that switches at
`next.startsAt` even when the patch is late. DESIGN.md §4.2–4.4 describes the behaviour but
leaves several things open:

- `timeline` is the scheduler's output, but nothing in the state records a take or interrupt
  as an input to it.
- After a take or interrupt, the rotation must continue with the *next* item. An anchor time
  alone can't express that.
- What happens to the item on air when the playlist is edited.
- How long a take or interrupt lasts when no duration is given.
- When an item whose time window closes mid-run stops.
- How the viewer follows `startsAt`.

## Decision

**Live control is an input, `timeline` is the output.** The state gains a top-level
`live: { main?, interrupt?, blackout }`.
- `live.main` is a take, or the scene frozen under an interrupt. It has the shape of
  `timeline.main`.
- `live.interrupt` has the shape of `timeline.interrupt`.

`resolveTimeline(state, t)` reads only `playlist`, `live`, `instances` and `plugins`, so it
is idempotent and the server and every viewer get the same answer. `timeline` stays in
state: it is the server's resolution at the latest revision, for the admin and as a
checkpoint.

**The anchor has an item.** `playlist.anchorItemId` (optional) names the item the rotation
starts from at `anchorAt`. When it is absent or unknown, the rotation starts from the first
item. An ID rather than an index, so reordering doesn't move it.

**Rotation.**
- From the anchor, the rotation walks the playlist in order, wrapping around.
- It starts each item that is enabled, playable (`isPlayableScene`) and inside its time window
  at the moment it would start.
- A started item always plays to its end, even if its window closes meanwhile.
- When nothing is eligible, only the background shows, and `next` is the item that the next
  window opening brings.
- Between window boundaries the eligible set is fixed, so whole cycles are skipped
  arithmetically. An anchor days old resolves in microseconds.
- An instance on air in two consecutive slots stays mounted, because the compositor keys
  scenes by instance.

**`next`** is set whenever the following scene is known, so it is announced as soon as the
current item starts. This meets "at least 10 s before" for any item that runs 10 s or more.
It is absent while a take or interrupt holds.

**Take and interrupt.**
- `live.take { instanceId, durationMs? }` sets `live.main` from now.
- `live.interrupt { instanceId, durationMs?, dimBelow? }` (with `dimBelow` defaulting to
  `false`) sets `live.interrupt`, and freezes the scene on air into `live.main` until the
  interrupt ends. This pauses the rotation. An interrupt over an empty main layer keeps the
  rotation from starting.
- Without `durationMs`, both hold until cleared.
- Both point the anchor at the item after the one that was on air. The anchor time is where
  the live control ends; for a hold, it is set when the hold is cleared.
- An interrupt during a take ends the take with it. Afterwards the rotation continues with
  the next item, per §4.4.
- `live.resume` ends any take and interrupt, and the rotation continues now. It is a no-op
  when neither is on air.
- `live.clearInterrupt` does the same, but is `422` without an active interrupt.
- `live.blackout { on }` sets `live.blackout`.
- Take and interrupt need a playable scene: an unknown instance is `404`, and a broken or
  overlay instance is `422`.
- Deleting an instance also clears it from `live`.

**Edits never restart the show.** The rotation's effective content is, per item: ID,
instance, enabled-and-playable, resolved duration and window. When it changes, the anchor is
moved so that the show continues:
- If the item on air is still eligible, the anchor becomes that item's start and ID. It keeps
  playing, with its new duration; if that has already run out, the rotation moves on.
- Otherwise the anchor becomes now, at the item after it in the old order.
- While live control is on air, only an anchor item that was removed is replaced.

Adding an item, renaming an instance or changing an overlay leaves the anchor alone.

**Durations.**
- `resolvedDurationMs` is the item's `durationMs`, else the type's
  `duration(config, settings)`, else `DEFAULT_DURATION_MS`.
- `DEFAULT_DURATION_MS` is 15 s, which settles the open question in DESIGN.md §11.
- A `duration` that throws or returns anything but a positive finite number gets the default.
- The plugin host now keeps `duration` on loaded types; it never enters state.

**Cues.**
- An unfired cue that is due is applied as of its own `at`, in time order, and marked `fired`.
  This includes cues found overdue at boot.
- A take or interrupt that would already have ended has no effect.
- `activateTheme` with an unknown theme, or a take of an unplayable instance, is just marked
  fired.
- The `cue.*` commands stay in M6.

**One scheduler step.** `settle(before, after, { now, catalog })` in core does, in order:
1. resolve durations
2. re-anchor on content changes
3. fire due cues
4. drop live control that has ended
5. store `resolveTimeline(state, now)` as `timeline`

`StateHub` runs it after every command, host command and `update`, in the same revision.
`hub.tick()` runs it with no change, and commits only if something changed.

**Server timer.**
- `Scheduler` keeps one timer for the earliest of `nextBoundary(timeline)` (the next start,
  main end or interrupt end) and the next unfired cue.
- It re-arms after every revision. A boundary already past fires at once.
- It sleeps at most 60 s, so a jump of the system clock corrects itself.
- Timers and the clock are injected.

**The viewer resolves on its own.**
- `<sb-compositor>` renders `resolveTimeline(state, ctx.serverNow())`, not `state.timeline`.
- It arms a timer for `nextBoundary` (at most 60 s away). A timer that fires early resolves
  the same timeline and re-arms.
- The screen therefore switches at `startsAt` without waiting for the patch, and keeps
  rotating through an outage.

**Persistence.** `live` and `playlist.anchorItemId` are `meta` keys. A database without them
loads the defaults quietly, so no schema migration is needed.

## Consequences

- A show runs unattended: the rotation, windows, takes, interrupts, blackout and cues are all
  resolved from state plus time, and a restart resumes where time says the rotation is.
- The viewer needs the resolved durations and plugin types in state, which it already has, and
  no plugin server code. Offline continuation in M10 only needs the service worker.
- `state.timeline` patches arrive at every transition. The viewer ignores them for rendering,
  but they keep the admin (M5) and resuming clients up to date.
- An item with a duration of zero cannot exist: durations are positive integers, so the
  rotation always advances.
- Takes and interrupts that hold can leave a screen on one scene indefinitely. The M5 live
  panel should make a hold visible.
- Deferred:
  - the `cue.*` commands (M6)
  - global defaults such as the default duration as a setting (M6)
  - offline caching of the viewer (M10)
