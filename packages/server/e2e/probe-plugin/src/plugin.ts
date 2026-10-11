// A plugin for the viewer e2e tests. Its element records its lifecycle on the page.
import { API_VERSION, definePlugin, z } from "@storbild/plugin-sdk";

export default definePlugin({
  id: "probe",
  version: "1.0.0",
  apiVersion: API_VERSION,
  types: {
    scene: {
      kind: "scene",
      label: "Probe",
      config: z.object({
        label: z.string(),
        prepareMs: z.number().int().nonnegative().default(0),
        failPrepare: z.boolean().default(false),
      }),
      viewer: "probe-scene",
    },
    // Edited with a custom editor from the plugin's admin module.
    card: {
      kind: "scene",
      label: "Probe card",
      config: z.object({ text: z.string().min(1) }),
      viewer: "probe-card",
      editor: "probe-card-editor",
    },
    // A fixed-size widget that goes stale at `staleAt` (server time), if given.
    widget: {
      kind: "overlay",
      label: "Probe widget",
      config: z.object({
        label: z.string(),
        width: z.number().int().positive().default(320),
        height: z.number().int().positive().default(80),
        staleAt: z.number().optional(),
      }),
      viewer: "probe-widget",
    },
    // A scene that keeps the bottom-right corner to itself.
    corner: {
      kind: "scene",
      label: "Probe corner",
      config: z.object({ label: z.string() }),
      viewer: "probe-corner",
      reserveSlots: ["bottom-right"],
    },
  },
});
