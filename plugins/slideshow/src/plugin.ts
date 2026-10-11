import { API_VERSION, definePlugin, fields, z } from "@storbild/plugin-sdk";

export default definePlugin({
  id: "slideshow",
  version: "0.1.0",
  apiVersion: API_VERSION,
  settings: z.object({
    perImageMs: fields
      .duration()
      .default(8_000)
      .meta({ title: "Time per image", description: "Unless a slideshow sets its own." }),
  }),
  types: {
    images: {
      kind: "scene",
      label: "Slideshow",
      config: z.object({
        images: z.array(fields.asset({ accept: ["image/*"] }).meta({ title: "Image" })).min(1),
        perImageMs: fields.duration().optional().meta({ title: "Time per image" }),
        fit: z
          .enum(["cover", "contain"])
          .default("cover")
          .meta({ description: "Cover fills the screen; contain shows the whole image." }),
      }),
      // One full round of the images.
      duration: (config, settings) =>
        config.images.length * (config.perImageMs ?? settings.perImageMs),
      background: "own",
      viewer: "sb-slideshow",
    },
  },
});
