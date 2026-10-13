import { API_VERSION, definePlugin, fields, z } from "@storbild/plugin-sdk";

export default definePlugin({
  // The ID is part of every stored instance and module URL; pick it once.
  id: "hello",
  version: "0.1.0",
  apiVersion: API_VERSION,
  types: {
    greeting: {
      kind: "scene",
      label: "Greeting",
      // The admin generates the instance form from this schema.
      config: z.object({
        message: fields.markdown().meta({ description: "Shown in large type, line by line." }),
        showClock: z.boolean().default(true).meta({ description: "Show the time below." }),
      }),
      viewer: "hello-greeting",
    },
  },
});
