import { API_VERSION, definePlugin, z } from "@storbild/plugin-sdk";

// Venue information widgets: the clock (ADR 0012) and the Wi-Fi network with a QR code to join
// it (ADR 0015).
export default definePlugin({
  id: "info",
  version: "0.2.0",
  apiVersion: API_VERSION,
  settings: z.object({
    timeZone: z
      .string()
      .optional()
      .meta({ description: "An IANA time zone such as Europe/Stockholm. Default: the screen's." }),
  }),
  types: {
    clock: {
      kind: "overlay",
      label: "Clock",
      config: z.object({
        seconds: z.boolean().default(false),
      }),
      viewer: "sb-info-clock",
    },
    wifi: {
      kind: "overlay",
      label: "Wi-Fi",
      config: z.object({
        label: z.string().optional().meta({ description: "Shown above the network name." }),
        ssid: z.string().min(1).meta({ title: "Network name" }),
        password: z.string().optional(),
        security: z
          .enum(["WPA", "WEP", "none"])
          .default("WPA")
          .meta({ description: "WPA covers WPA2 and WPA3. None is an open network." }),
        hidden: z.boolean().default(false).meta({ title: "Hidden network" }),
        showPassword: z
          .boolean()
          .default(true)
          .meta({ title: "Show password", description: "The QR code always contains it." }),
      }),
      viewer: "sb-info-wifi",
      editor: "sb-info-wifi-editor",
    },
  },
});
