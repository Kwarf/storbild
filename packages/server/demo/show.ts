// The demo show: a fictional party with content for every built-in plugin. It is built through
// the same commands the admin sends, so it stays valid as long as they do. Edit freely; times
// are relative to `now`, which is `DEMO_NOW` when taking screenshots.

/** 20:30 on the Saturday of the party, Stockholm time. */
export const DEMO_NOW = Date.parse("2026-08-01T20:30:00+02:00");
export const TIME_ZONE = "Europe/Stockholm";

/** Issues one command and returns the ID of what it created, if anything. */
export type CommandFn = (type: string, payload: unknown) => Promise<string | undefined>;

/** Uploaded files by their name in `images.ts`, as asset IDs. */
export type AssetIds = Record<string, string>;

const MINUTE = 60_000;

/** Seeds the show and returns the instance IDs by name. */
export async function seedShow(
  command: CommandFn,
  assets: AssetIds,
  now: number,
): Promise<Record<string, string>> {
  const asset = (name: string) => {
    const id = assets[name];
    if (!id) throw new Error(`no uploaded file named ${name}`);
    return id;
  };
  const ids: Record<string, string> = {};
  const instance = async (name: string, plugin: string, type: string, config: unknown) => {
    ids[name] = (await command("instance.create", { plugin, type, name, config })) as string;
  };
  // Minutes from now, on a whole minute.
  const at = (minutes: number) => now + minutes * MINUTE;

  await command("plugin.updateSettings", { plugin: "info", settings: { timeZone: TIME_ZONE } });

  const theme = await command("theme.create", {
    name: "Pixelnatt",
    background: { type: "image", assetId: asset("background.jpg"), fit: "cover", dim: 0.2 },
    fonts: {
      heading: {
        family: "Instrument Sans",
        faces: [{ assetId: asset("instrument-sans-600.woff2"), weight: 600, style: "normal" }],
      },
      body: {
        family: "Instrument Sans",
        faces: [{ assetId: asset("instrument-sans-400.woff2"), weight: 400, style: "normal" }],
      },
    },
    colors: { text: "#f4f1ff", muted: "#b3a9d6", accent: "#ff5fa2", surface: "#1b1433" },
  });
  await command("theme.activate", { id: theme });

  // Scenes.
  await instance("Welcome", "markdown", "text", {
    content: [
      "# Welcome to Pixelnatt 2026",
      "",
      "Three nights of demos, music and graphics by the lake.",
      "Grab a seat, plug in, and say hi to the orgas at the info desk.",
    ].join("\n"),
    align: "center",
    verticalAlign: "center",
  });
  await instance("Tonight", "markdown", "text", {
    content: [
      "## Tonight",
      "",
      "- **21:00** Streaming music compo",
      "- **22:00** Combined demo compo",
      "- **23:30** Live act: Kvarts & the Bitplanes",
      "- **01:00** Oldskool party in the cellar",
    ].join("\n"),
    align: "left",
    verticalAlign: "center",
  });
  await instance("House rules", "markdown", "text", {
    content: [
      "## House rules",
      "",
      "1. Be excellent to each other.",
      "2. No smoking inside the hall.",
      "3. Keep the emergency exits clear.",
      "4. Sleep in the sleeping hall, not under your desk.",
    ].join("\n"),
    align: "left",
    verticalAlign: "center",
  });
  await instance("Photos", "slideshow", "images", {
    images: [asset("photo-stage.jpg"), asset("photo-hall.jpg"), asset("photo-lake.jpg")],
    fit: "cover",
  });
  await instance("Demo compo countdown", "countdown", "countdown", {
    title: "Combined demo compo",
    target: at(90),
    doneText: "Starting now!",
  });
  await instance("Pizza", "announcement", "announcement", {
    title: "Pizza has arrived",
    message: "Pick up your order at the info desk.\nBring your receipt.",
    tone: "info",
  });
  await instance("Deadline", "announcement", "announcement", {
    title: "Compo deadline in 30 minutes",
    message: "Hand in your entries at the compo desk.",
    tone: "urgent",
  });

  // Overlay widgets.
  await instance("Clock", "info", "clock", { seconds: false });
  await instance("Party Wi-Fi", "info", "wifi", {
    ssid: "pixelnatt",
    password: "greetings2026",
    security: "WPA",
  });
  await instance("Next compo", "countdown", "widget", {
    label: "Demo compo",
    target: at(90),
    hideAfterMs: 5 * MINUTE,
  });
  await instance("Info desk", "markdown", "widget", {
    content: "**Info desk** open until 02:00\nLost and found, tickets, plasters",
    align: "left",
  });

  // The rotation.
  for (const name of ["Welcome", "Tonight", "Photos", "Demo compo countdown", "House rules"]) {
    await command("playlist.addItem", { instanceId: ids[name] });
  }

  await command("overlay.place", { instanceId: ids.Clock, slot: "top-right" });
  await command("overlay.place", { instanceId: ids["Party Wi-Fi"], slot: "bottom-right" });
  await command("overlay.place", { instanceId: ids["Next compo"], slot: "bottom-left" });
  await command("overlay.place", { instanceId: ids["Info desk"], slot: "top-left" });

  // The schedule: the deadline call, then the countdown on air before the compo starts.
  await command("cue.create", {
    at: at(60),
    action: { type: "interrupt", instanceId: ids.Deadline, durationMs: MINUTE, below: "dim" },
  });
  await command("cue.create", {
    at: at(85),
    action: { type: "take", instanceId: ids["Demo compo countdown"], durationMs: 5 * MINUTE },
  });

  return ids;
}
