import { API_VERSION, definePlugin, fields, z } from "@storbild/plugin-sdk";

const target = () =>
  fields.datetime().meta({
    title: "Counts down to",
    description: "Date and time, or use In… for a time from now.",
  });
const doneText = () =>
  z.string().optional().meta({
    title: "When it's time",
    description: "Shown once the time is reached. Default: 00:00.",
  });

// Counts down to a point in time (ADR 0015).
export default definePlugin({
  id: "countdown",
  version: "0.1.0",
  apiVersion: API_VERSION,
  types: {
    countdown: {
      kind: "scene",
      label: "Countdown",
      // No duration of its own: it runs for the show's default duration.
      config: z.object({ title: z.string().optional(), target: target(), doneText: doneText() }),
      viewer: "sb-countdown-scene",
    },
    widget: {
      kind: "overlay",
      label: "Countdown",
      config: z.object({
        label: z.string().optional(),
        target: target(),
        doneText: doneText(),
        hideAfterMs: fields.duration().default(300_000).meta({
          title: "Hide after",
          description: "How long it stays once the time is reached.",
        }),
      }),
      viewer: "sb-countdown-widget",
    },
  },
});
