# 9. Split M6 into M6a and M6b

Date: 2026-10-11

## Status

Accepted

## Context

After M5 the admin can control a show but not build one. Content still has to be created
through the API. M6 as written in DESIGN.md §9 covers that, but it bundles a lot: the asset
store, a schema-driven form renderer, five pages, and quick announce, which depends on a
plugin from M9. That is too much for one plan and one reviewable change.

ADR 0008 also made a dedicated `announcement` plugin more valuable. Only an interrupt that
draws its own panel makes the `dim` and `show` modes useful, so a stub plugin would be wasted
work.

## Decision

M6 is split in two, done in order.

- **M6a: admin forms and content pages.**
  - The form renderer from `z.toJSONSchema()`, with custom editor support.
  - The Library, Rotation, Plugins and Settings pages.
  - Settings makes the default rotation duration and the transition length real settings.
  - Done when a show of text scenes can be built in the admin alone and runs unattended.
- **M6b: assets, schedule and quick announce.**
  - The asset store, plus an asset picker form component.
  - The `cue.*` commands and the Schedule page.
  - The `announcement` plugin, moved here from M9.
  - Quick announce.
  - Done when a full show with images and cues can be built in the admin, and a typed
    message can be announced in seconds.

The dependencies move with it:

- M7's admin theme editor needs M6b, for the asset picker (fonts, image backgrounds).
- M8's admin overlays page needs only M6a.

Earlier ADRs that defer work to "M6" map as follows:

| Deferred item | Source | Now in |
|---|---|---|
| generated forms from JSON Schema | ADR 0004 | M6a |
| removing a `missing` plugin for good | ADR 0004 | M6a (Plugins page) |
| global defaults as settings | ADRs 0005, 0006 | M6a |
| `cue.*` commands | ADRs 0003, 0006 | M6b |
| quick announce | ADR 0007 | M6b |

Three M5 leftovers (ADR 0007) are not assigned to a milestone. Pick them up where they fit:

- a connected-screens count in the admin
- a layout for narrow screens
- plugin webhook routes that work without a session

## Consequences

- Each half can be planned in a fresh session from DESIGN.md §9 alone.
- After M6a the admin is useful for text-only shows. M8's admin page could be started then,
  in parallel with M6b.
- M9 shrinks by one plugin.
