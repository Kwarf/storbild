// A small zip writer and reader for show files (ADR 0019). The writer stores entries without
// compression (assets are compressed already) and switches to ZIP64 records only past 4 GiB.
// The reader takes stored and deflated entries, so a show file zipped again by an OS tool
// still imports.

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
  forceZip64?: boolean;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
/** Bit 11: names are UTF-8. */
const FLAG_UTF8 = 0x0800;

/** A little-endian record builder. */
class Record {
  readonly #view: DataView;
  readonly bytes: Uint8Array;
  #at = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.#view = new DataView(this.bytes.buffer);
  }

  u16(value: number) {
    this.#view.setUint16(this.#at, value, true);
    this.#at += 2;
    return this;
  }

  u32(value: number) {
    this.#view.setUint32(this.#at, value >>> 0, true);
    this.#at += 4;
    return this;
  }

  u64(value: number) {
    this.#view.setBigUint64(this.#at, BigInt(value), true);
    this.#at += 8;
    return this;
  }

  raw(bytes: Uint8Array) {
    this.bytes.set(bytes, this.#at);
    this.#at += bytes.length;
    return this;
  }
}

/** The DOS date and time fields of a local time. */
function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function crcOf(data: Blob): Promise<number> {
  let crc = 0;
  for await (const chunk of data.stream()) crc = Bun.hash.crc32(chunk, crc);
  return crc;
}

/**
 * Streams a zip of `sources`. Each entry's CRC is computed by reading its data once before
 * writing it, so the sizes and CRC go in the local header and no data descriptor is needed,
 * which every reader handles. Sources may be an async iterable, so they can be produced as
 * the archive is written.
 */
export function writeZip(
  sources: Iterable<ZipSource> | AsyncIterable<ZipSource>,
  { modifiedAt = Date.now(), forceZip64 = false }: ZipWriteOptions = {},
): ReadableStream<Uint8Array> {
  const { time, date } = dosDateTime(modifiedAt);
  const encoder = new TextEncoder();

  async function* generate(): AsyncGenerator<Uint8Array> {
    const central: Uint8Array[] = [];
    let offset = 0;
    let count = 0;
    for await (const { name, data } of sources) {
      const nameBytes = encoder.encode(name);
      const size = data.size;
      const crc = await crcOf(data);
      const big = forceZip64 || size >= MAX32;
      const local = new Record(30 + nameBytes.length + (big ? 20 : 0))
        .u32(SIG_LOCAL)
        .u16(big ? 45 : 20)
        .u16(FLAG_UTF8)
        .u16(0)
        .u16(time)
        .u16(date)
        .u32(crc)
        .u32(big ? MAX32 : size)
        .u32(big ? MAX32 : size)
        .u16(nameBytes.length)
        .u16(big ? 20 : 0)
        .raw(nameBytes);
      if (big) local.u16(ZIP64_EXTRA).u16(16).u64(size).u64(size);
      yield local.bytes;
      let written = 0;
      for await (const chunk of data.stream()) {
        written += chunk.length;
        yield chunk;
      }
      if (written !== size) throw new Error(`${name} changed size while it was written`);

      const farOffset = forceZip64 || offset >= MAX32;
      const extra = (big ? 16 : 0) + (farOffset ? 8 : 0);
      const entry = new Record(46 + nameBytes.length + (extra ? 4 + extra : 0))
        .u32(SIG_CENTRAL)
        .u16(45)
        .u16(big || farOffset ? 45 : 20)
        .u16(FLAG_UTF8)
        .u16(0)
        .u16(time)
        .u16(date)
        .u32(crc)
        .u32(big ? MAX32 : size)
        .u32(big ? MAX32 : size)
        .u16(nameBytes.length)
        .u16(extra ? 4 + extra : 0)
        .u16(0)
        .u16(0)
        .u16(0)
        .u32(0)
        .u32(farOffset ? MAX32 : offset)
        .raw(nameBytes);
      if (extra) {
        entry.u16(ZIP64_EXTRA).u16(extra);
        if (big) entry.u64(size).u64(size);
        if (farOffset) entry.u64(offset);
      }
      central.push(entry.bytes);
      offset += local.bytes.length + size;
      count++;
    }

    const centralOffset = offset;
    let centralSize = 0;
    for (const entry of central) {
      centralSize += entry.length;
      yield entry;
    }
    const big = forceZip64 || count >= MAX16 || centralOffset >= MAX32 || centralSize >= MAX32;
    if (big) {
      const end64Offset = centralOffset + centralSize;
      yield new Record(56)
        .u32(SIG_END64)
        .u64(44)
        .u16(45)
        .u16(45)
        .u32(0)
        .u32(0)
        .u64(count)
        .u64(count)
        .u64(centralSize)
        .u64(centralOffset).bytes;
      yield new Record(20).u32(SIG_LOCATOR64).u32(0).u64(end64Offset).u32(1).bytes;
    }
    yield new Record(22)
      .u32(SIG_END)
      .u16(0)
      .u16(0)
      .u16(big ? MAX16 : count)
      .u16(big ? MAX16 : count)
      .u32(big ? MAX32 : centralSize)
      .u32(big ? MAX32 : centralOffset)
      .u16(0).bytes;
  }

  const chunks = generate();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}

/** An entry of an archive being read. */
export interface ZipEntry {
  name: string;
  /** 0 is stored, 8 is deflate. */
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** Where the entry's local header starts. */
  offset: number;
}

/**
 * What the reader needs of an archive: its size and random access. `Bun.file()` has both, as
 * does a `Blob` at runtime.
 */
export interface ZipInput {
  readonly size: number;
  slice(
    start: number,
    end: number,
  ): { arrayBuffer(): Promise<ArrayBuffer>; stream(): ReadableStream<Uint8Array> };
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.length);

async function readBytes(file: ZipInput, start: number, length: number): Promise<Uint8Array> {
  if (start < 0 || start + length > file.size) throw new ZipError("the archive is truncated");
  return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
}

/** A 64-bit field as a safe integer. */
function u64(data: DataView, at: number): number {
  const value = data.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError("an archive field is too large");
  return Number(value);
}

/**
 * Reads an archive's central directory from a file on disk. Entries are read lazily with
 * `ZipReader.stream`.
 */
export class ZipReader {
  private constructor(
    readonly file: ZipInput,
    readonly entries: Map<string, ZipEntry>,
  ) {}

  static async open(file: ZipInput): Promise<ZipReader> {
    // The end record is 22 bytes plus a comment of at most 64 KiB.
    const tailLength = Math.min(file.size, 22 + MAX16);
    const tail = await readBytes(file, file.size - tailLength, tailLength);
    const tailView = view(tail);
    let end = -1;
    for (let at = tail.length - 22; at >= 0; at--) {
      if (tailView.getUint32(at, true) === SIG_END) {
        end = at;
        break;
      }
    }
    if (end === -1) throw new ZipError("not a zip archive");
    let count = tailView.getUint16(end + 10, true);
    let centralSize = tailView.getUint32(end + 12, true);
    let centralOffset = tailView.getUint32(end + 16, true);

    if (count === MAX16 || centralSize === MAX32 || centralOffset === MAX32) {
      const locatorAt = file.size - tailLength + end - 20;
      const locator = view(await readBytes(file, locatorAt, 20));
      if (locator.getUint32(0, true) !== SIG_LOCATOR64) throw new ZipError("missing ZIP64 locator");
      const end64 = view(await readBytes(file, u64(locator, 8), 56));
      if (end64.getUint32(0, true) !== SIG_END64) throw new ZipError("bad ZIP64 end record");
      count = u64(end64, 32);
      centralSize = u64(end64, 40);
      centralOffset = u64(end64, 48);
    }

    const central = await readBytes(file, centralOffset, centralSize);
    const data = view(central);
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const entries = new Map<string, ZipEntry>();
    let at = 0;
    for (let i = 0; i < count; i++) {
      if (at + 46 > central.length || data.getUint32(at, true) !== SIG_CENTRAL) {
        throw new ZipError("bad central directory");
      }
      const flags = data.getUint16(at + 8, true);
      if (flags & 0x0001) throw new ZipError("encrypted archives aren't supported");
      const method = data.getUint16(at + 10, true);
      const crc = data.getUint32(at + 16, true);
      let compressedSize = data.getUint32(at + 20, true);
      let size = data.getUint32(at + 24, true);
      const nameLength = data.getUint16(at + 28, true);
      const extraLength = data.getUint16(at + 30, true);
      const commentLength = data.getUint16(at + 32, true);
      let offset = data.getUint32(at + 42, true);
      const nameStart = at + 46;
      const extraStart = nameStart + nameLength;
      const next = extraStart + extraLength + commentLength;
      if (next > central.length) throw new ZipError("bad central directory");
      const name = decoder.decode(central.subarray(nameStart, extraStart));

      // The ZIP64 extra field holds, in order, only the values that overflowed.
      for (let x = extraStart; x + 4 <= extraStart + extraLength; ) {
        const id = data.getUint16(x, true);
        const length = data.getUint16(x + 2, true);
        if (id === ZIP64_EXTRA) {
          let y = x + 4;
          const take = () => {
            if (y + 8 > x + 4 + length) throw new ZipError("bad ZIP64 extra field");
            const value = u64(data, y);
            y += 8;
            return value;
          };
          if (size === MAX32) size = take();
          if (compressedSize === MAX32) compressedSize = take();
          if (offset === MAX32) offset = take();
        }
        x += 4 + length;
      }
      if (name.endsWith("/")) {
        at = next;
        continue;
      }
      if (entries.has(name)) throw new ZipError(`the archive has two entries named ${name}`);
      entries.set(name, { name, method, crc, compressedSize, size, offset });
      at = next;
    }
    return new ZipReader(file, entries);
  }

  /**
   * Streams an entry's content. It errors when the entry isn't stored or deflated, when it
   * inflates past its declared size (a zip bomb), or when its size or CRC don't match.
   */
  async stream(entry: ZipEntry): Promise<ReadableStream<Uint8Array>> {
    if (entry.method !== 0 && entry.method !== 8) {
      throw new ZipError(`${entry.name} uses an unsupported compression method`);
    }
    const header = view(await readBytes(this.file, entry.offset, 30));
    if (header.getUint32(0, true) !== SIG_LOCAL) throw new ZipError(`bad header for ${entry.name}`);
    const start = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    if (start + entry.compressedSize > this.file.size)
      throw new ZipError("the archive is truncated");
    let body = this.file.slice(start, start + entry.compressedSize).stream();
    if (entry.method === 8) {
      body = body.pipeThrough(
        new DecompressionStream("deflate-raw") as unknown as TransformStream<
          Uint8Array,
          Uint8Array
        >,
      );
    }
    let size = 0;
    let crc = 0;
    return body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.length;
          if (size > entry.size) {
            controller.error(new ZipError(`${entry.name} is larger than it says`));
            return;
          }
          crc = Bun.hash.crc32(chunk, crc);
          controller.enqueue(chunk);
        },
        flush(controller) {
          if (size !== entry.size || crc !== entry.crc) {
            controller.error(new ZipError(`${entry.name} is damaged`));
          }
        },
      }),
    );
  }

  /** An entry's content as text, refused above `maxBytes`. */
  async text(entry: ZipEntry, maxBytes: number): Promise<string> {
    if (entry.size > maxBytes) throw new ZipError(`${entry.name} is too large`);
    return new Response(await this.stream(entry)).text();
  }
}
