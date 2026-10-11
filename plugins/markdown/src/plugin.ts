import { API_VERSION, definePlugin, fields, z } from "@storbild/plugin-sdk";

export default definePlugin({
  id: "markdown",
  version: "0.4.0",
  apiVersion: API_VERSION,
  settings: z.object({ fontScale: z.number().positive().default(1) }),
  types: {
    text: {
      kind: "scene",
      label: "Markdown text",
      // No duration of its own: text runs for the show's default duration.
      config: z.object({ content: fields.markdown() }),
      // Version 1 had a separate `title`; it becomes a heading at the top of the content.
      configVersion: 2,
      migrate: (fromVersion, config) => {
        if (fromVersion !== 1) return config;
        const { title, content } = config as { title?: string; content: string };
        return { content: title ? `# ${title}\n\n${content}` : content };
      },
      viewer: "sb-markdown-scene",
    },
  },
});
