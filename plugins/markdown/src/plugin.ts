import { API_VERSION, definePlugin, fields, z } from "@storbild/plugin-sdk";

export default definePlugin({
  id: "markdown",
  version: "0.3.0",
  apiVersion: API_VERSION,
  settings: z.object({ fontScale: z.number().positive().default(1) }),
  types: {
    text: {
      kind: "scene",
      label: "Markdown text",
      // No duration of its own: text runs for the show's default duration.
      config: z.object({ title: z.string().optional(), content: fields.markdown() }),
      viewer: "sb-markdown-scene",
    },
  },
});
