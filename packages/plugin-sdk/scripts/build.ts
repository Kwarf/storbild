// Builds the published @storbild/plugin-sdk into dist/ (ADR 0026): JavaScript for each subpath
// with @storbild/core bundled in, declarations for the SDK and core, and a package.json.
// Publish from dist/, never from this directory.
import { cpSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pluginExternals } from "../src/build.ts";

const root = join(import.meta.dir, "..");
const repo = join(root, "../..");
const src = join(root, "src");
const dist = join(root, "dist");
const subpaths = { ".": "index", "./viewer": "viewer", "./admin": "admin", "./build": "build" };

rmSync(dist, { recursive: true, force: true });

// lit and zod are peers, and plugin builds keep the SDK itself external (pluginExternals).
const external = pluginExternals.filter((name) => !name.startsWith("@storbild/"));
const result = await Bun.build({
  entrypoints: Object.values(subpaths).map((name) => join(src, `${name}.ts`)),
  outdir: dist,
  root: src,
  format: "esm",
  target: "browser",
  splitting: true,
  external,
  naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]" },
  throw: false,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

/** Runs the workspace's tsc. */
function tsc(...args: string[]) {
  const run = Bun.spawnSync([process.execPath, "x", "tsc", ...args], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (run.exitCode !== 0) process.exit(run.exitCode ?? 1);
}
const declarations = ["--noEmit", "false", "--declaration", "--emitDeclarationOnly"];
tsc("-p", join(root, "tsconfig.json"), ...declarations, "--rootDir", src, "--outDir", dist);
tsc("-p", join(root, "tsconfig.build.json"), ...declarations, "--rootDir", src, "--outDir", dist);
// Core's files are outside the SDK program's emit, so they get a run of their own.
const core = join(repo, "packages/core");
const coreOut = join(dist, "core");
tsc(
  "-p",
  join(core, "tsconfig.json"),
  ...declarations,
  "--rootDir",
  join(core, "src"),
  "--outDir",
  coreOut,
);
rmSync(join(coreOut, "test"), { recursive: true, force: true });

/** Every file below `dir`. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

// Declarations keep the sources' specifiers: `./x.ts` becomes `./x.js`, which resolves to
// `x.d.ts` without TypeScript-only settings, and `@storbild/core` points at the bundled copy.
for (const file of files(dist).filter((path) => path.endsWith(".d.ts"))) {
  let toCore = relative(dirname(file), join(coreOut, "index.js"));
  if (!toCore.startsWith(".")) toCore = `./${toCore}`;
  const code = await Bun.file(file).text();
  await Bun.write(
    file,
    code
      .replace(/(from\s+|import\s*\(\s*|import\s+)(["'])(\.{1,2}\/[^"']+)\.ts\2/g, "$1$2$3.js$2")
      .replace(/(["'])@storbild\/core\1/g, `$1${toCore}$1`),
  );
}

const pkg = await Bun.file(join(root, "package.json")).json();
const exports = Object.fromEntries(
  Object.entries(subpaths).map(([path, name]) => [
    path,
    { types: `./${name}.d.ts`, default: `./${name}.js` },
  ]),
);
await Bun.write(
  join(dist, "package.json"),
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      license: pkg.license,
      repository: pkg.repository,
      homepage: pkg.homepage,
      keywords: pkg.keywords,
      type: "module",
      exports,
      peerDependencies: { ...pkg.peerDependencies, "@types/bun": "*" },
      // Only `./build` needs Bun's types.
      peerDependenciesMeta: { "@types/bun": { optional: true } },
    },
    null,
    2,
  )}\n`,
);
cpSync(join(root, "README.md"), join(dist, "README.md"));
cpSync(join(root, "CHANGELOG.md"), join(dist, "CHANGELOG.md"));
cpSync(join(repo, "LICENSE"), join(dist, "LICENSE"));
console.log(`built ${pkg.name}@${pkg.version} in ${relative(process.cwd(), dist) || "."}`);
