import { API_VERSION, definePlugin, z } from "@storbild/plugin-sdk";

// Venue information widgets. The clock comes first (ADR 0012); Wi-Fi with a QR code follows in
// M9.
export default definePlugin({
  id: "info",
  version: "0.1.0",
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
  },
});
