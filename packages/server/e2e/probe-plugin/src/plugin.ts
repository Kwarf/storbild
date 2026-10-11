// A scene plugin for the viewer e2e tests. Its element records its lifecycle on the page.
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
  },
});
