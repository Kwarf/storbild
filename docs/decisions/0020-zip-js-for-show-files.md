# 20. zip.js for show files

Date: 2026-10-12

## Status

Accepted. Replaces the "zip code is our own" part of ADR 0019.

## Context

ADR 0019 made show files one zip and wrote the writer and reader ourselves, with no
dependency. That was about 390 lines of record layouts, ZIP64 handling and central directory
parsing. A zip format bug there would damage exports or let a bad import through, and the code
needs the same review as everything else for no gain to the show.

What show files need from a zip library:

- Stream an export of several GB without holding it in memory, with ZIP64 past 4 GiB.
- Read an upload on disk by random access (central directory first, then each entry), without
  loading it into memory.
- Read stored and deflated entries, so a file zipped again by an OS tool still imports.
- Check each entry's CRC, and stop an entry that inflates past its declared size.

## Decision

`packages/server/src/zip.ts` is a thin layer over
[`@zip.js/zip.js`](https://gildas-lormeau.github.io/zip.js/), pinned to an exact version. Its
exports (`writeZip`, `ZipReader`, `ZipError`) keep their shape, so `show-file.ts` is unchanged.

- **Writer.** A `ZipWriter` writes stored entries (`level: 0`) to a `TransformStream`, whose
  readable side is the export's body. zip.js writes data descriptors after each entry, so each
  file is read once rather than twice (the old writer read every file once for its CRC first).
  It switches to ZIP64 when an entry or the archive needs it. Tests force ZIP64 with `zip64`.
- **Reader.** A `ZipReader` over a `BlobReader` of `Bun.file()`, which reads only the ranges
  asked for. It reads with `checkCrc32`, and zip.js stops an entry that inflates past its
  declared size. What zip.js throws becomes a `ZipError`, including errors in the middle of an
  entry's stream, so the import still answers 400.
- zip.js runs in-process (`useWebWorkers: false`).

Two traps in wrapping it: zip.js can fail an entry without closing the stream it writes into,
and a source that fails in the middle of an export leaves the stream zip.js writes to locked
and open. Either would hang a request. `zip.ts` fails the stream in both cases, and tests cover
them.

zip.js was chosen over fflate (no ZIP64, and its streaming reader goes front to back), yauzl
plus yazl (two packages, built on Node streams and callbacks) and JSZip (whole archive in
memory).

## Consequences

- About 250 fewer lines of zip format code to maintain.
- A dependency with no dependencies of its own. It is a large library with a broad API; only
  `zip.ts` imports it.
- Exports use data descriptors, which Python's `zipfile` and Info-ZIP's `unzip` read.
- An archive with its start cut off still opens; its entries then fail to read. The import
  reads `show.json` first, so it is refused as before.
- A 4.4 GB entry was round-tripped by hand, and Python's `zipfile` accepts it. CI covers ZIP64
  with forced records on a small archive.
