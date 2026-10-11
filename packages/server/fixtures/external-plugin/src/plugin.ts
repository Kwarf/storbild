// A third-party plugin used by the M2 acceptance test. Tests copy it outside the repository,
// where it can only reach the SDK (and lit, a peer dependency).
import { API_VERSION, definePlugin, z } from "@storbild/plugin-sdk";

const plugin = definePlugin({
  id: "external",
  version: "1.2.3",
  apiVersion: API_VERSION,
  settings: z.object({ greeting: z.string().default("hello") }),
  types: {
    banner: {
      kind: "overlay",
      label: "Banner",
      config: z.object({ text: z.string(), repeat: z.number().int().min(1).default(1) }),
      viewer: "ext-banner",
    },
  },
  server(ctx) {
    const publish = () =>
      ctx.setPluginState({
        greeting: ctx.settings().greeting,
        banners: ctx.instances("banner").map((banner) => banner.config.text),
      });
    publish();
    ctx.onSettingsChange(publish);
    ctx.onInstancesChange(publish);
    ctx.route((request) =>
      Response.json({ path: new URL(request.url).pathname, greeting: ctx.settings().greeting }),
    );
  },
});

export default plugin;
