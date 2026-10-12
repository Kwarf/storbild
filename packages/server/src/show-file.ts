import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type AssetMeta, CommandError, exportShow, parseShowFile } from "@storbild/core";
import type { AssetStore } from "./assets.ts";
import type { StateHub } from "./state-hub.ts";
import { writeZip, ZipError, ZipReader, type ZipSource } from "./zip.ts";

/** The largest `show.json` an import reads. Shows are tens of kilobytes. */
const MAX_SHOW_JSON_BYTES = 64 * 1024 * 1024;

const assetEntry = /^assets\/([0-9a-f]{64})$/;
const thumbnailEntry = /^thumbnails\/([0-9a-f]{64})\.webp$/;

export type ImportResult =
  | { ok: true; revision: number; missingPlugins: string[] }
  | {
      ok: false;
      status: 400 | 413 | 422;
      error: "invalid_show_file" | "too_large" | "invalid";
      message: string;
      issues?: unknown[];
    };

export interface ShowFilesOptions {
  hub: StateHub;
  assets: AssetStore;
  /** Where uploads are kept while they are read. Emptied on start. */
  tmpDir: string;
  now: () => number;
}

/**
 * Exports the show as one zip and imports one (ADR 0019). The zip holds `show.json`, each
 * asset at `assets/<id>`, and thumbnails at `thumbnails/<id>.webp`.
 */
export class ShowFiles {
  readonly #hub: StateHub;
  readonly #assets: AssetStore;
  readonly #tmpDir: string;
  readonly #now: () => number;

  constructor({ hub, assets, tmpDir, now }: ShowFilesOptions) {
    this.#hub = hub;
    this.#assets = assets;
    this.#tmpDir = tmpDir;
    this.#now = now;
  }

  /** Removes what an interrupted import left behind. */
  start() {
    mkdirSync(this.#tmpDir, { recursive: true });
    for (const name of readdirSync(this.#tmpDir)) {
      if (name.startsWith("import-")) rmSync(join(this.#tmpDir, name), { force: true });
    }
  }

  /** The show as it is now, streamed as a zip. */
  export(): ReadableStream<Uint8Array> {
    const now = this.#now();
    const file = exportShow(this.#hub.state, now);
    const assets = this.#assets;
    async function* sources(): AsyncGenerator<ZipSource> {
      yield { name: "show.json", data: new Blob([`${JSON.stringify(file, null, 2)}\n`]) };
      for (const asset of file.assets) {
        const found = assets.file(asset.id);
        if (!found) continue;
        yield { name: `assets/${asset.id}`, data: Bun.file(found.path) };
        const thumbnail = assets.thumbnail(asset.id);
        if (thumbnail && (await Bun.file(thumbnail).exists())) {
          yield { name: `thumbnails/${asset.id}.webp`, data: Bun.file(thumbnail) };
        }
      }
    }
    return writeZip(sources(), { modifiedAt: now });
  }

  /**
   * Replaces the show with an uploaded show file. The upload is streamed to disk, every asset is
   * checked against its hash, and the show is replaced in one revision. Nothing changes when
   * anything is wrong.
   */
  async import(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<ImportResult> {
    mkdirSync(this.#tmpDir, { recursive: true });
    const path = join(this.#tmpDir, `import-${crypto.randomUUID()}.zip`);
    try {
      if (!(await saveUpload(body, path, maxBytes))) {
        return {
          ok: false,
          status: 413,
          error: "too_large",
          message: `Show files can be at most ${Math.round(maxBytes / (1024 * 1024))} MB.`,
        };
      }
      return await this.#importFrom(path);
    } catch (error) {
      if (error instanceof ZipError) return invalid(`The show file is damaged: ${error.message}.`);
      throw error;
    } finally {
      rmSync(path, { force: true });
    }
  }

  async #importFrom(path: string): Promise<ImportResult> {
    const zip = await ZipReader.open(Bun.file(path));
    for (const name of zip.entries.keys()) {
      if (name !== "show.json" && !assetEntry.test(name) && !thumbnailEntry.test(name)) {
        return invalid(`The show file contains ${name}, which a show file never has.`);
      }
    }
    const showEntry = zip.entries.get("show.json");
    if (!showEntry) return invalid("This is not a Storbild show file: show.json is missing.");
    let json: unknown;
    try {
      json = JSON.parse(await zip.text(showEntry, MAX_SHOW_JSON_BYTES));
    } catch (error) {
      if (error instanceof SyntaxError) return invalid("The show file's show.json isn't JSON.");
      throw error;
    }
    const parsed = parseShowFile(json);
    if (!parsed.ok) return invalid(parsed.message, parsed.issues);

    const assets: AssetMeta[] = [];
    try {
      for (const asset of parsed.file.assets) {
        const entry = zip.entries.get(`assets/${asset.id}`);
        if (!entry) return invalid(`The file of ${asset.name} is missing from the show file.`);
        const stored = await this.#assets.ingest(await zip.stream(entry), asset);
        if (!stored) return invalid(`The file of ${asset.name} is damaged or not an allowed type.`);
        const thumbnail = zip.entries.get(`thumbnails/${asset.id}.webp`);
        const kept =
          thumbnail !== undefined &&
          thumbnail.size <= 256 * 1024 &&
          (await this.#assets.ingestThumbnail(
            asset.id,
            new Uint8Array(await new Response(await zip.stream(thumbnail)).arrayBuffer()),
          ));
        assets.push(kept ? { ...stored, thumbnail: true } : stored);
      }
      const revision = this.#hub.dispatchHost({
        type: "show.import",
        payload: { ...parsed.file, assets },
      });
      const missingPlugins = Object.entries(this.#hub.state.plugins)
        .filter(([, plugin]) => plugin.status === "missing")
        .map(([id]) => id);
      return { ok: true, revision, missingPlugins };
    } catch (error) {
      if (error instanceof CommandError) {
        return { ok: false, status: 422, error: "invalid", message: error.message };
      }
      throw error;
    } finally {
      // Files stored for an import that didn't happen, or that the show no longer uses.
      this.#assets.discardUnused();
    }
  }
}

function invalid(message: string, issues?: unknown[]): ImportResult {
  return {
    ok: false,
    status: 400,
    error: "invalid_show_file",
    message,
    ...(issues && { issues }),
  };
}

/** Streams an upload to `path`; false, with nothing kept, when it passes `maxBytes`. */
async function saveUpload(
  body: ReadableStream<Uint8Array>,
  path: string,
  maxBytes: number,
): Promise<boolean> {
  const writer = Bun.file(path).writer();
  const reader = body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return false;
      }
      writer.write(value);
    }
    return true;
  } finally {
    await writer.end();
  }
}
