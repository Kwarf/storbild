import { API_VERSION, definePlugin, z } from "@storbild/plugin-sdk";

export default definePlugin({
  id: "markdown",
  version: "0.1.0",
  apiVersion: API_VERSION,
  settings: z.object({ fontScale: z.number().positive().default(1) }),
  types: {
    text: {
      kind: "scene",
      label: "Markdown text",
      config: z.object({ title: z.string().optional(), content: z.string() }),
      duration: () => 15_000,
      viewer: "sb-markdown-scene",
    },
  },
});
