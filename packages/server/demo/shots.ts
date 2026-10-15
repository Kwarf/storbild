// The screenshots for the README, taken in this order into docs/screenshots/<name>.png and
// listed in docs/screenshots.md. Before each one the show is reset to the seeded
// state, so any shot can be taken on its own. Edit freely: `prepare` gets the page ready and
// resolves once it looks right.
import type { Page } from "playwright";
import type { CommandFn } from "./show.ts";

export interface Demo {
  /** The viewer at 1920×1080. */
  screen: Page;
  /** The admin at 1440×900, logged in, in dark mode. */
  admin: Page;
  command: CommandFn;
  /** Instance IDs by name, from `seedShow`. */
  ids: Record<string, string>;
  /** Opens an admin section by its sidebar label. */
  section(label: string): Promise<void>;
  /** Waits until the scene is fully shown in a layer of the screen's compositor. */
  onScreen(name: string, layer?: "main" | "interrupt"): Promise<void>;
}

export interface Shot {
  name: string;
  /** The caption in docs/screenshots.md. */
  title: string;
  page: "screen" | "admin";
  prepare(demo: Demo): Promise<void>;
}

const take = async (demo: Demo, name: string) => {
  await demo.command("live.take", { instanceId: demo.ids[name] });
  await demo.onScreen(name);
};

export const shots: Shot[] = [
  // The screen.
  {
    name: "screen-welcome",
    title: "Welcome text with the theme and overlays",
    page: "screen",
    prepare: (demo) => demo.onScreen("Welcome"),
  },
  {
    name: "screen-tonight",
    title: "Markdown text",
    page: "screen",
    prepare: (demo) => take(demo, "Tonight"),
  },
  {
    name: "screen-slideshow",
    title: "Slideshow",
    page: "screen",
    prepare: (demo) => take(demo, "Photos"),
  },
  {
    name: "screen-countdown",
    title: "Countdown",
    page: "screen",
    prepare: (demo) => take(demo, "Demo compo countdown"),
  },
  {
    name: "screen-announcement",
    title: "Announcement over the dimmed screen",
    page: "screen",
    prepare: async (demo) => {
      await demo.command("live.interrupt", { instanceId: demo.ids.Pizza, below: "dim" });
      await demo.onScreen("Pizza", "interrupt");
    },
  },

  // The admin.
  { name: "admin-live", title: "Live", page: "admin", prepare: (demo) => demo.section("Live") },
  {
    name: "admin-rotation",
    title: "Rotation",
    page: "admin",
    prepare: (demo) => demo.section("Rotation"),
  },
  {
    name: "admin-schedule",
    title: "Schedule",
    page: "admin",
    prepare: (demo) => demo.section("Schedule"),
  },
  {
    name: "admin-library",
    title: "Library",
    page: "admin",
    prepare: async ({ admin, section }) => {
      await section("Library");
      await admin.getByRole("button", { name: "Tonight" }).click();
      await admin
        .getByLabel("Instance editor")
        .locator('sb-compositor .scene[data-phase="current"]')
        .waitFor();
    },
  },
  {
    name: "admin-overlays",
    title: "Overlays",
    page: "admin",
    prepare: (demo) => demo.section("Overlays"),
  },
  { name: "admin-theme", title: "Theme", page: "admin", prepare: (demo) => demo.section("Theme") },
  {
    name: "admin-plugins",
    title: "Plugins",
    page: "admin",
    prepare: (demo) => demo.section("Plugins"),
  },
  {
    name: "admin-settings",
    title: "Settings",
    page: "admin",
    prepare: (demo) => demo.section("Settings"),
  },
];
