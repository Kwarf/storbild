import { API_VERSION, definePlugin, fields, z } from "@storbild/plugin-sdk";

export default definePlugin({
  id: "announcement",
  version: "0.1.0",
  apiVersion: API_VERSION,
  types: {
    announcement: {
      kind: "scene",
      label: "Announcement",
      // Meant for interrupts and takes, which set their own duration; in the rotation it runs
      // for the show's default.
      config: z.object({
        title: z.string().optional(),
        message: fields.markdown().meta({ description: "Shown as plain text, line by line." }),
        tone: z
          .enum(["info", "urgent"])
          .default("info")
          .meta({ description: "Urgent adds an accent band." }),
      }),
      viewer: "sb-announcement",
    },
  },
});
