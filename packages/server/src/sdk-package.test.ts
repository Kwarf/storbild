import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Storbild, start } from "./main.ts";
import { testConfig } from "./testing.ts";

// The pack test (ADR 0026): the built SDK, packed as it is published, installed into a copy of
// the plugin template outside the repository. The template must type check and pass its tests
// against it, and load in the host. Needs the network for the template's other dependencies,
// so it only runs with STORBILD_PACK=1.

const enabled = process.env.STORBILD_PACK === "1";
const repoRoot = join(import.meta.dir, "../../..");
const sdkDir = join(repoRoot, "packages/plugin-sdk");

function run(cmd: string[], cwd: string) {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed:\n${output}`);
  return output;
}

describe.skipIf(!enabled)("published SDK", () => {
  let root: string;
  let plugin: string;
  let storbild: Storbild | undefined;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "storbild-pack-"));
    run([process.execPath, "run", "build"], sdkDir);
    run(["npm", "pack", "--pack-destination", root], join(sdkDir, "dist"));
    const tarball = readdirSync(root).find((name) => name.endsWith(".tgz"));
    if (!tarball) throw new Error("npm pack wrote no tarball");

    plugin = join(root, "hello");
    cpSync(join(repoRoot, "templates/plugin"), plugin, {
      recursive: true,
      filter: (path) => !path.includes("node_modules"),
    });
    // Until the version is on npm, the peer must resolve to the tarball too.
    const pkgPath = join(plugin, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const local = `file:${join(root, tarball)}`;
    pkg.devDependencies["@storbild/plugin-sdk"] = local;
    pkg.peerDependencies["@storbild/plugin-sdk"] = local;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    run([process.execPath, "install"], plugin);
  }, 120_000);

  afterAll(async () => {
    await storbild?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("contains only the build, with no workspace references", () => {
    const installed = join(plugin, "node_modules/@storbild/plugin-sdk/package.json");
    const pkg = JSON.parse(readFileSync(installed, "utf8"));
    expect(JSON.stringify(pkg)).not.toContain("workspace:");
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual(["@types/bun", "lit", "zod"]);
  });

  test("the template type checks and passes its tests", () => {
    run([process.execPath, "run", "typecheck"], plugin);
    run([process.execPath, "test"], plugin);
  }, 60_000);

  test("the template loads in the host", async () => {
    storbild = await start(
      testConfig({
        STORBILD_VIEWER_PORT: "0",
        STORBILD_ADMIN_PORT: "0",
        STORBILD_DATA_DIR: join(root, "data"),
        STORBILD_PLUGIN_PATHS: plugin,
      }),
      { builtinPluginsDir: null },
    );
    const entry = storbild.hub.state.plugins.hello;
    expect(entry?.status).toBe("ok");
    expect(entry?.types.greeting?.viewer).toBe("hello-greeting");
    const res = await fetch(new URL(`${entry?.module}`, storbild.viewer.url));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('customElements.define("hello-greeting"');
  });
});
