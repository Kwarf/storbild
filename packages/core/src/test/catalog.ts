import { z } from "zod";
import type { PluginCatalog } from "../schema/plugin.ts";

/** A plugin catalog for tests: `markdown` (ok), `legacy` (incompatible). */
export const testCatalog: PluginCatalog = {
  markdown: {
    id: "markdown",
    version: "1.0.0",
    status: "ok",
    module: "/plugins/markdown/1.0.0/viewer.js",
    settings: z.object({ fontScale: z.number().positive().default(1) }),
    types: {
      text: {
        kind: "scene",
        label: "Text",
        viewer: "sb-markdown-scene",
        config: z.object({ content: z.string() }),
        configVersion: 1,
      },
      // Version 1 stored `{ n: "3" }`; version 2 is `{ count: 3, step: 1 }`.
      counter: {
        kind: "overlay",
        label: "Counter",
        viewer: "sb-counter",
        config: z.object({ count: z.number().int(), step: z.number().int().default(1) }),
        configVersion: 2,
        migrate: (from, config) => {
          if (from !== 1) throw new Error(`unknown version ${from}`);
          return { count: Number((config as { n: string }).n) };
        },
      },
    },
  },
  legacy: { id: "legacy", version: "0.1.0", status: "incompatible", error: "needs API 0" },
};
