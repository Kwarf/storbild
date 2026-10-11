# 18. A markdown overlay widget

Date: 2026-10-11

## Status

Accepted

## Context

`markdown/text` (ADR 0015, ADR 0017) is a full-screen scene. Short standing notes, such as
"Compo entries close at 18:00" or a sponsor line, belong on top of whatever is on air, and
no overlay shows free text today. `countdown` already has a scene and an overlay that share
their fields.

## Decision

`markdown` gets an overlay type, `widget`, labelled "Markdown text" like the scene. Its config
is `content` (markdown) and `align` (left, center, right; default left). It has no vertical
alignment, because a widget sizes itself and its slot places it (ADR 0012).

The widget is drawn like the other widgets: padded, on `--sb-color-surface` with rounded
corners, in the theme's body font at 28 px times the plugin's `fontScale`. It uses the
scene's typography and sanitizing. Block quotes and code, which the scene draws on the
surface colour, are tinted from the text colour instead. Images are at most 200 px high.

It is not shrunk to fit. It wraps at its slot's width, and text beyond the slot's height cap
is clipped, as for every widget. It has no `staleAt()`, so it stays until it is removed.

The plugin's version goes to 0.6.0.

## Consequences

- Operators can place free text in any slot without a custom plugin.
- A long text in a top or bottom slot is clipped at 240 px. The preview shows this.
- The scene and the widget share their styles, so a change to one's typography changes both.
