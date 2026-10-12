// Zip writing and reading for show files (ADR 0019, ADR 0020), on top of zip.js. The writer
// stores entries without compression (assets are compressed already); zip.js switches to ZIP64
// when an entry or the archive needs it. The reader takes stored and deflated entries, so a show
// file zipped again by an OS tool still imports.

import {
  BlobReader,
  configure,
  type FileEntry,
  ZipReader as JsZipReader,
  ZipWriter,
} from "@zip.js/zip.js";

// Workers would load a separate script; the server runs everything in-process.
configure({ useWebWorkers: false });

/** A malformed or unsupported archive. */
export class ZipError extends Error {
  override name = "ZipError";
}

/** A file to write: its name in the archive and its content. */
export interface ZipSource {
  name: string;
  data: Blob;
}

export interface ZipWriteOptions {
  /** Last-modified time of every entry, epoch ms. */
  modifiedAt?: number;
  /** Writes ZIP64 records even for small archives, for tests. */
  zip64?: boolean;
}

/**
 * Streams a zip of `sources`. Sources may be an async iterable, so they can be produced as the
 * archive is written.
 */
export function writeZip(
  sources: Iterable<ZipSource> | AsyncIterable<ZipSource>,
  { modifiedAt = Date.now(), zip64 = false }: ZipWriteOptions = {},
): ReadableStream<Uint8Array> {
  // The controller errors the stream even while zip.js holds `writable` locked.
  let pipe: TransformStreamDefaultController<Uint8Array> | undefined;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      pipe = controller;
    },
  });
  const writer = new ZipWriter(writable, { level: 0, lastModDate: new Date(modifiedAt), zip64 });
  (async () => {
    for await (const { name, data } of sources) await writer.add(name, new BlobReader(data));
    await writer.close();
  })().catch((error) => pipe?.error(error));
  return readable;
}

/** An entry of an archive being read. */
export interface ZipEntry {
  name: string;
  /** The uncompressed size the archive declares. */
  size: number;
  file: FileEntry;
}

/** Runs a zip.js call, turning what it throws into a `ZipError`. */
async function zipCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError(error instanceof Error ? error.message : String(error));
  }
}

/** Reads an archive's central directory from a file on disk, then entries lazily. */
export class ZipReader {
  private constructor(readonly entries: Map<string, ZipEntry>) {}

  /** `Bun.file()` reads only the ranges asked for, so the archive isn't loaded into memory. */
  static async open(file: Blob): Promise<ZipReader> {
    const reader = new JsZipReader(new BlobReader(file), { checkCrc32: true });
    const entries = new Map<string, ZipEntry>();
    for (const entry of await zipCall(() => reader.getEntries())) {
      if (entry.directory) continue;
      if (entries.has(entry.filename)) {
        throw new ZipError(`the archive has two entries named ${entry.filename}`);
      }
      if (entry.encrypted) throw new ZipError("encrypted archives aren't supported");
      entries.set(entry.filename, {
        name: entry.filename,
        size: entry.uncompressedSize,
        file: entry,
      });
    }
    return new ZipReader(entries);
  }

  /**
   * Streams an entry's content. It errors with a `ZipError` when the entry isn't stored or
   * deflated, when it inflates past its declared size (a zip bomb), or when its CRC doesn't match.
   */
  async stream(entry: ZipEntry): Promise<ReadableStream<Uint8Array>> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const done = zipCall(() => entry.file.getData(writable));
    // zip.js can fail without closing `writable` (a missing local header), so each read races
    // its failure, which is also the error worth reporting.
    const failed = done.then(() => new Promise<never>(() => {}));
    failed.catch(() => {});
    const reader = readable.getReader();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done: end, value } = await Promise.race([
          reader.read().catch(async (error) => {
            await done;
            throw error;
          }),
          failed,
        ]).catch(async (error) => {
          await reader.cancel(error).catch(() => {});
          throw error;
        });
        if (!end) {
          controller.enqueue(value);
          return;
        }
        await done;
        controller.close();
      },
      async cancel(reason) {
        await reader.cancel(reason);
        await done.catch(() => {});
      },
    });
  }

  /** An entry's content as text, refused above `maxBytes`. */
  async text(entry: ZipEntry, maxBytes: number): Promise<string> {
    if (entry.size > maxBytes) throw new ZipError(`${entry.name} is too large`);
    return new Response(await this.stream(entry)).text();
  }
}
