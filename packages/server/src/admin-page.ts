import { fontFiles } from "@storbild/admin";
import { type AppBundle, buildApp, once } from "./app-bundle.ts";
import type { ModuleFiles } from "./plugins/bundle.ts";

/** The admin app's browser bundle, with its fonts under `fonts/`. */
export type AdminBundle = AppBundle;

export const getAdminBundle = once(async () => {
  const fonts: ModuleFiles = new Map();
  for (const [name, url] of fontFiles) {
    fonts.set(`fonts/${name}`, {
      body: new Blob([await Bun.file(url).arrayBuffer()]),
      type: "font/woff2",
    });
  }
  return buildApp(Bun.resolveSync("@storbild/admin/main", import.meta.dir), "admin", fonts);
});
