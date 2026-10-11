# 3. State, sync and persistence

Date: 2026-10-11

## Status

Accepted

## Context

M1 (DESIGN.md §9) asks for the state schemas, a command bus with a reducer, SQLite
persistence, and the SSE sync protocol of §5. DESIGN.md fixes the protocol but leaves the
mechanics open: where the reducer lives, how patches are produced, how state maps to tables,
and what `Last-Event-ID` means across restarts. It also lists a command catalogue (§5.4) whose
commands mostly depend on later milestones.

## Decision

**Command scope.** M1 implements `instance.create|update|delete` and
`playlist.addItem|updateItem|removeItem|reorder`. The rest of §5.4 arrives with the milestone
that gives it meaning: `plugin.updateSettings` in M2 (with plugin-schema validation of instance
config), `live.*` in M4, `cue.*` in M6, `theme.*` in M7 and `overlay.*` in M8. Until M2,
instance config is any JSON value.

**A pure reducer in core.** `applyCommand(state, command, { now, newId })` in `packages/core`
returns the next state with `revision` bumped, or throws `CommandError` (`not_found` or
`invalid`). Time and IDs are injected. The server's `StateHub` wraps it.

**Patches come from a diff.** The server diffs the state before and after each command rather
than having the reducer emit patches. `diff` emits `add`/`remove`/`replace` at the narrowest
path: objects are compared key by key, arrays of equal length index by index, and an array
whose length changes is replaced whole. Any producer of a new state (for example a plugin
replacing its whole state object in M2) gets narrow patches, and no dependency is needed.
`applyPatch` lives next to it for the viewer. Every patch includes `replace /revision`.

**Deleting an instance cascades.** In the same revision, the playlist items, overlay placements
and cues that reference it are removed. Deleting an instance used as a theme background is
rejected, because a theme cannot lose its background.

**Create returns the ID.** `POST /api/commands` returns `{ revision, id }` for commands that
create an entity. IDs are generated on the server (UUIDs).

**`Timeline.main` is optional.** With nothing to show (an empty or all-disabled playlist) only
the theme background renders. Until the scheduler (M4), the timeline is a placeholder
`{ mode: "auto", blackout: false }`.

**Persistence.** One `STRICT` table per collection (`instances`, `playlist_items`, `cues`,
`overlays`, `themes`, `plugins`) with the entity as a JSON `data` column, plus a `meta`
key/value table for `revision`, `activeThemeId`, `playlist.anchorAt` and the `timeline`
checkpoint. After each command, the top-level state keys touched by the patch are rewritten in
one transaction, before the patch is broadcast. Shows have tens of rows, so rewriting a whole
collection is cheap and needs no per-row bookkeeping. Plugin `status` is not stored, because
the plugin host recomputes it on load. Rows that fail validation on load are logged and
skipped. Schema migrations use `PRAGMA user_version`. A fresh database is seeded with one
default theme so `activeThemeId` is always valid.

**Revisions and resume.** The revision is persisted, so it keeps increasing across restarts.
The patch ring buffer (256 entries) is in memory. A stream resumes when
`base ≤ Last-Event-ID ≤ current`, where `base` is the revision at boot or the newest revision
dropped from the buffer. Anything else (no header, malformed, rolled past, or ahead of the
server) gets a snapshot.

**Clock.** `estimateOffset` keeps the lowest-RTT half of the samples and takes the median
offset. `createServerClock(localNow)` slews toward a new offset at 5% (50 ms per second) so
`serverNow()` never runs backwards, and snaps corrections over 1 s. It has no timers: the slew
is applied lazily when the clock is read.

## Consequences

- Each later milestone adds its commands to `commandSchema` and the reducer, and adds reducer
  tests.
- The admin can create an instance and immediately reference it without refetching.
- After a restart the buffer is empty, so only a viewer whose `Last-Event-ID` equals the
  persisted revision resumes; all others get a snapshot. If the database is swapped for another
  one that happens to have the same revision, such a viewer would keep stale state, so reload
  the viewers after swapping databases by hand.
- Bun's default 10 s idle timeout is raised to 60 s on both servers, so SSE streams survive
  between 15 s heartbeats.
