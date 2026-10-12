# 21. file-type and image-size for sniffing uploads

Date: 2026-10-12

## Status

Accepted. Replaces the "plain TypeScript" part of ADR 0011.

## Context

ADR 0011 has the server judge an upload's type by its content and read an image's size from
its header, "in plain TypeScript". `sniff.ts` grew to about 200 lines of format parsing: JPEG
segments, three WebP variants, AVIF boxes, MP4 brands, WebM's EBML header and SVG attributes.
It guards what goes into the asset store, and like the zip code (ADR 0020) it is format code
that well-used libraries already have.

## Decision

`sniff()` uses two libraries, pinned to exact versions:

- **[file-type](https://github.com/sindresorhus/file-type)** names the type of the binary
  formats: PNG, JPEG, GIF, WebP, AVIF, MP4, WebM and woff2. An allowlist maps its MIME types
  to the ones kept. `video/x-m4v` (the `M4V ` brand) is kept as `video/mp4`, as before.
  Anything else it recognises, such as QuickTime, Matroska or HEIC, is refused.
- **[image-size](https://github.com/image-size/image-size)** reads the width and height of
  every image type, SVG included. A header it can't read leaves the type without a size.

file-type doesn't handle text formats, and image-size counts a file as SVG when `<svg` appears
anywhere in its first kilobyte, which HTML with an inline SVG passes. So the one check of our
own is that the document's root element is `<svg>`, after an optional XML prolog, comments
and an SVG doctype (ADR 0011's rule, unchanged).

file-type is async, so `sniff()` is now async.

## Consequences

- About 150 fewer lines of format parsing. `sniff.ts` keeps the allowlist and the SVG root
  check.
- Eleven new packages: image-size has no dependencies, and file-type brings nine with it
  (`strtok3`, `token-types`, `@tokenizer/inflate`, `debug` and smaller ones).
- SVG sizes accept more units (`in`, `cm`, `pt` and others are converted to px), where the
  old code read only px. A `viewBox` separated by commas no longer gives a size.
- An AVIF's size is read from the `ispe` box under `meta` › `iprp` › `ipco`, as the format
  places it, rather than from the first `ispe` found anywhere in the first 64 KiB.
- An MP4 is recognised by its major brand. The old code also accepted a known brand in the
  compatible list.
