import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeZip, ZipError, ZipReader, type ZipSource } from "./zip.ts";

const text = (value: string) => new Blob([value]);

async function zipToBytes(sources: ZipSource[], zip64 = false) {
  return new Uint8Array(await new Response(writeZip(sources, { zip64 })).arrayBuffer());
}

async function contents(reader: ZipReader) {
  const result: Record<string, string> = {};
  for (const entry of reader.entries.values()) result[entry.name] = await reader.text(entry, 1e9);
  return result;
}

const sources = () => [
  { name: "show.json", data: text('{"a":1}') },
  { name: "assets/abc", data: new Blob([new Uint8Array(70_000).map((_, i) => i % 251)]) },
  { name: "empty", data: text("") },
  { name: "ünicode.txt", data: text("åäö") },
];

describe("zip", () => {
  for (const zip64 of [false, true]) {
    test(`round-trips entries${zip64 ? " with ZIP64 records" : ""}`, async () => {
      const reader = await ZipReader.open(new Blob([await zipToBytes(sources(), zip64)]));
      expect([...reader.entries.keys()]).toEqual([
        "show.json",
        "assets/abc",
        "empty",
        "ünicode.txt",
      ]);
      const read = await contents(reader);
      expect(read["show.json"]).toBe('{"a":1}');
      expect(read["ünicode.txt"]).toBe("åäö");
      const entry = reader.entries.get("assets/abc");
      if (!entry) throw new Error("missing");
      const bytes = new Uint8Array(await new Response(await reader.stream(entry)).arrayBuffer());
      expect(bytes).toEqual(new Uint8Array(70_000).map((_, i) => i % 251));
    });
  }

  test("fails the stream when a source fails", async () => {
    async function* failing(): AsyncGenerator<ZipSource> {
      yield { name: "show.json", data: text("{}") };
      throw new Error("the disk is gone");
    }
    await expect(new Response(writeZip(failing())).arrayBuffer()).rejects.toThrow(/disk is gone/);
  });

  test("reads deflated entries written by another tool, skipping directories", async () => {
    const reader = await ZipReader.open(
      Bun.file(join(import.meta.dir, "../fixtures/deflated.zip")),
    );
    expect([...reader.entries.keys()]).toEqual(["show.json"]);
    expect(await contents(reader)).toEqual({ "show.json": '{"hello": "deflate"}'.repeat(50) });
  });

  test("stops an entry that inflates past its declared size", async () => {
    const bytes = await Bun.file(join(import.meta.dir, "../fixtures/deflated.zip")).bytes();
    const data = new DataView(bytes.buffer);
    // Declare 10 bytes in every local and central header, where the entry inflates to 1000.
    for (let at = 0; at + 4 <= bytes.length; at++) {
      const signature = data.getUint32(at, true);
      if (signature === 0x04034b50) data.setUint32(at + 22, 10, true);
      if (signature === 0x02014b50) data.setUint32(at + 24, 10, true);
    }
    const reader = await ZipReader.open(new Blob([bytes]));
    const entry = reader.entries.get("show.json");
    if (!entry) throw new Error("missing");
    expect(entry.size).toBe(10);
    await expect(reader.text(entry, 1e9)).rejects.toThrow(ZipError);
  });

  test.skipIf(!Bun.which("python3"))("Python's zipfile reads what it writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "storbild-zip-"));
    try {
      for (const zip64 of [false, true]) {
        const path = join(dir, `${zip64}.zip`);
        await Bun.write(path, await zipToBytes(sources(), zip64));
        const python = Bun.spawnSync([
          "python3",
          "-c",
          "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); print(z.testzip(), len(z.namelist()))",
          path,
        ]);
        expect(python.stdout.toString().trim()).toBe("None 4");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses what isn't a zip, and truncated archives", async () => {
    await expect(ZipReader.open(text("hello"))).rejects.toThrow(ZipError);
    const whole = await zipToBytes(sources());
    await expect(ZipReader.open(new Blob([whole.subarray(0, -30)]))).rejects.toThrow(ZipError);
    // Without its start, the directory still opens but its entries can't be read.
    const headless = await ZipReader.open(new Blob([whole.subarray(100)]));
    for (const entry of headless.entries.values()) {
      await expect(headless.text(entry, 1e9)).rejects.toThrow(ZipError);
    }
  });

  test("detects damaged content", async () => {
    const bytes = await zipToBytes(sources());
    const at = Buffer.from(bytes).indexOf('{"a":1}');
    bytes[at] = "x".charCodeAt(0);
    const reader = await ZipReader.open(new Blob([bytes]));
    const entry = reader.entries.get("show.json");
    if (!entry) throw new Error("missing");
    await expect(reader.text(entry, 1e9)).rejects.toThrow(ZipError);
    await expect(reader.text(entry, 3)).rejects.toThrow(/too large/);
  });
});
