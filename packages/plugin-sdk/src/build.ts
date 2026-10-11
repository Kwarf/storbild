// Build preset for plugins (DESIGN.md §6.3). Runs under Bun.

/**
 * Modules the host provides. Plugin builds must keep them external, so every plugin shares the
 * host's single copy (in the browser via the import map).
 */
export const pluginExternals = [
  "lit",
  "lit/*",
  "@storbild/plugin-sdk",
  "@storbild/plugin-sdk/*",
  "zod",
];

export interface BuildPluginOptions {
  /** The definition module (`exports["."]`) and the viewer module (`storbild.viewer`). */
  entrypoints: string[];
  outdir: string;
  minify?: boolean;
}

/** Builds plugin entry points to ESM with the host-provided modules external. */
export function buildPlugin({ entrypoints, outdir, minify = false }: BuildPluginOptions) {
  return Bun.build({
    entrypoints,
    outdir,
    format: "esm",
    target: "browser",
    splitting: true,
    minify,
    sourcemap: "linked",
    external: pluginExternals,
  });
}
