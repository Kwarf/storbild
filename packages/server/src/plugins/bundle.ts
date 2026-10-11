import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pluginExternals } from "@storbild/plugin-sdk/build";
import type { BunPlugin } from "bun";

/** A built file, served from memory. */
export interface ModuleFile {
  body: Blob;
  type: string;
}

/** Built files by path relative to their URL prefix, e.g. `viewer.js` or `lit/index.js`. */
export type ModuleFiles = Map<string, ModuleFile>;

const sdkDir = dirname(Bun.resolveSync("@storbild/plugin-sdk/package.json", import.meta.dir));

/** Matches the modules the host provides to plugins (see `pluginExternals`). */
const hostModule = /^(?:lit|@storbild\/plugin-sdk)(?:\/.*)?$|^zod$/;

/**
 * Points the host-provided modules at the host's own files, so a plugin's server code shares
 * the host's single copy of the SDK and Zod even when it has no node_modules of its own.
 * Bun's runtime resolver hooks don't apply to bare imports, so plugins are bundled instead.
 */
const hostModules: BunPlugin = {
  name: "storbild-host-modules",
  setup(build) {
    build.onResolve({ filter: hostModule }, (args) => ({
      path: Bun.resolveSync(args.path, sdkDir),
      external: true,
    }));
  },
};

function logsOf(result: Bun.BuildOutput): string {
  return result.logs.map((log) => String(log.message ?? log)).join("\n") || "build failed";
}

export async function toFiles(outputs: Bun.BuildArtifact[], prefix = ""): Promise<ModuleFiles> {
  const files: ModuleFiles = new Map();
  for (const output of outputs) {
    const path = prefix + output.path.replace(/^\.\//, "");
    const type = path.endsWith(".js") ? "text/javascript; charset=utf-8" : output.type;
    files.set(path, { body: new Blob([await output.arrayBuffer()]), type });
  }
  return files;
}

/**
 * Bundles a plugin's definition module for the server and imports it. The output goes to
 * `cacheDir` under a content hash, because Bun can only import files.
 */
export async function importDefinition(entry: string, cacheDir: string): Promise<unknown> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    format: "esm",
    plugins: [hostModules],
    throw: false,
  });
  const output = result.outputs.find((o) => o.kind === "entry-point");
  if (!result.success || !output) throw new Error(logsOf(result));
  const code = await output.text();
  const file = join(cacheDir, `${Bun.hash(code).toString(16)}.js`);
  mkdirSync(cacheDir, { recursive: true });
  await Bun.write(file, code);
  return ((await import(file)) as { default?: unknown }).default;
}

/**
 * Bundles one of a plugin's browser modules (`viewer` or `admin`) with the host modules left
 * external. The entry is `<name>.js`; chunk names are content hashes, so the files of both
 * modules can be served from one map.
 */
export async function bundleBrowser(entry: string, name: string): Promise<ModuleFiles> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    splitting: true,
    external: pluginExternals,
    naming: { entry: `${name}.[ext]`, chunk: "chunk-[hash].[ext]", asset: "asset-[hash].[ext]" },
    throw: false,
  });
  if (!result.success) throw new Error(logsOf(result));
  return toFiles(result.outputs);
}

export interface Vendor {
  /** Content hash of all vendor files; part of their URL. */
  hash: string;
  files: ModuleFiles;
  /** Bare specifier to path below `/vendor/<hash>/`. */
  specifiers: Record<string, string>;
}

/** Picks the browser production file from a package.json `exports` value. */
function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const conditions = value as Record<string, unknown>;
  return exportTarget(conditions.browser ?? conditions.import ?? conditions.default);
}

/**
 * Builds lit and its entry points, Zod, and the SDK's browser subpaths. Each is a separate build
 * that keeps the others external, so the browser loads one copy of each via the import map.
 * Lit's entry points share chunks, so there is a single lit-html.
 */
async function buildVendor(): Promise<Vendor> {
  const files: ModuleFiles = new Map();
  const specifiers: Record<string, string> = {};
  const build = async (
    name: string,
    root: string,
    entries: Record<string, string>,
    external: string[],
  ) => {
    const result = await Bun.build({
      entrypoints: Object.values(entries).map((file) => join(root, file)),
      root,
      target: "browser",
      format: "esm",
      splitting: true,
      minify: true,
      external,
      naming: { entry: "[dir]/[name].[ext]", chunk: "chunk-[hash].[ext]" },
      throw: false,
    });
    if (!result.success) throw new Error(`vendor build of ${name} failed: ${logsOf(result)}`);
    for (const [path, file] of await toFiles(result.outputs, `${name}/`)) files.set(path, file);
    for (const [specifier, file] of Object.entries(entries)) {
      specifiers[specifier] = `${name}/${file.replace(/^\.\//, "").replace(/\.ts$/, ".js")}`;
    }
  };

  const packageOf = (name: string) => {
    const path = Bun.resolveSync(`${name}/package.json`, sdkDir);
    return { dir: dirname(path), json: require(path) as { exports: Record<string, unknown> } };
  };
  const lit = packageOf("lit");
  const litEntries: Record<string, string> = {};
  for (const [key, value] of Object.entries(lit.json.exports)) {
    const target = exportTarget(value);
    if (target?.endsWith(".js")) litEntries[key === "." ? "lit" : `lit/${key.slice(2)}`] = target;
  }
  const zod = packageOf("zod");
  const zodEntry = exportTarget(zod.json.exports["."]);
  if (!zodEntry) throw new Error("cannot find Zod's browser entry");

  await build("lit", lit.dir, litEntries, []);
  await build("zod", zod.dir, { zod: zodEntry }, []);
  await build(
    "plugin-sdk",
    join(sdkDir, "src"),
    {
      "@storbild/plugin-sdk": "index.ts",
      "@storbild/plugin-sdk/viewer": "viewer.ts",
      "@storbild/plugin-sdk/admin": "admin.ts",
    },
    ["lit", "lit/*", "zod"],
  );

  const hasher = new Bun.CryptoHasher("sha256");
  for (const [path, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hasher.update(path);
    hasher.update(await file.body.arrayBuffer());
  }
  return { hash: hasher.digest("hex").slice(0, 12), files, specifiers };
}

let vendor: Promise<Vendor> | undefined;

/** The vendor build, made once per process. */
export function getVendor(): Promise<Vendor> {
  vendor ??= buildVendor();
  vendor.catch(() => {
    vendor = undefined;
  });
  return vendor;
}
