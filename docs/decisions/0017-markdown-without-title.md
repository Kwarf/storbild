# 17. Markdown text without a title field

Date: 2026-10-11

## Status

Accepted

## Context

The `markdown/text` scene (ADR 0015) has an optional `title` next to its markdown `content`.
The scene renders the title as an `h1` with the same styles as a `#` heading in the content,
and nothing else reads it. Operators then have to choose between two places to write the
same heading, and the field only allows one level.

## Decision

`markdown/text` drops `title`, and its config is just `content`. A heading is written in the
markdown, usually as a `#` line at the top.

The type's `configVersion` becomes 2. `migrate` turns a version 1 config with a title into
`# <title>`, a blank line and the old content, so stored instances keep their heading. The
plugin's version goes to 0.4.0.

## Consequences

- One field to edit, and the heading's level is up to the operator.
- A migrated title is now parsed as markdown. A title that used markdown or HTML characters
  may render differently than before.
- Scenes with structured content, such as `countdown` and `announcement`, keep their titles.
  They have no markdown body to put a heading in.
