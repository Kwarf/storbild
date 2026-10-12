import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeZip, ZipError, type ZipInput, ZipReader, type ZipSource } from "./zip.ts";

const text = (value: string) => new Blob([value]);

/** Bun's `Blob` type lacks `slice` without the DOM lib, though every Blob has it. */
const input = (blob: Blob) => blob as unknown as ZipInput & Blob;

async function zipToBlob(sources: ZipSource[], forceZip64 = false) {
  return input(new Blob([await new Response(writeZip(sources, { forceZip64 })).arrayBuffer()]));
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
  for (const forceZip64 of [false, true]) {
    test(`round-trips entries${forceZip64 ? " with ZIP64 records" : ""}`, async () => {
      const reader = await ZipReader.open(await zipToBlob(sources(), forceZip64));
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

  test("reads deflated entries written by another tool, skipping directories", async () => {
    const reader = await ZipReader.open(
      Bun.file(join(import.meta.dir, "../fixtures/deflated.zip")),
    );
    expect([...reader.entries.keys()]).toEqual(["show.json"]);
    expect(await contents(reader)).toEqual({ "show.json": '{"hello": "deflate"}'.repeat(50) });
  });

  test.skipIf(!Bun.which("python3"))("Python's zipfile reads what it writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "storbild-zip-"));
    try {
      for (const forceZip64 of [false, true]) {
        const path = join(dir, `${forceZip64}.zip`);
        await Bun.write(path, await zipToBlob(sources(), forceZip64));
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
    await expect(ZipReader.open(input(text("hello")))).rejects.toThrow(ZipError);
    const whole = await zipToBlob(sources());
    await expect(ZipReader.open(input(whole.slice(0, whole.size - 30) as Blob))).rejects.toThrow(
      ZipError,
    );
    await expect(ZipReader.open(input(whole.slice(100, whole.size) as Blob))).rejects.toThrow(
      ZipError,
    );
  });

  test("detects damaged content", async () => {
    const bytes = new Uint8Array(await (await zipToBlob(sources())).arrayBuffer());
    // The first byte of show.json's content, after its 30-byte header and 9-byte name.
    bytes[39] = "x".charCodeAt(0);
    const reader = await ZipReader.open(input(new Blob([bytes])));
    const entry = reader.entries.get("show.json");
    if (!entry) throw new Error("missing");
    await expect(reader.text(entry, 1e9)).rejects.toThrow(/damaged/);
    await expect(reader.text(entry, 3)).rejects.toThrow(/too large/);
  });
});
