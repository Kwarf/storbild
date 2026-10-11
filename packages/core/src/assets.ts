import type { ShowState } from "./schema/state.ts";

/** Something in the show that references an asset. */
export interface AssetUser {
  kind: "instance" | "theme";
  id: string;
  name: string;
}

/** Whether `id` occurs as a string anywhere in a JSON value. */
function mentions(value: unknown, id: string): boolean {
  if (value === id) return true;
  if (Array.isArray(value)) return value.some((item) => mentions(item, id));
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) => mentions(item, id));
  }
  return false;
}

/**
 * Lists what references an asset (ADR 0011): instances whose background is the asset or whose
 * config holds its ID as a string anywhere, and themes whose background or fonts use it. Asset
 * IDs are content hashes, so an exact string match in a config needs no schema.
 */
export function assetUsers(state: ShowState, id: string): AssetUser[] {
  const users: AssetUser[] = [];
  for (const instance of Object.values(state.instances)) {
    const background =
      typeof instance.background === "object" && instance.background.assetId === id;
    if (background || mentions(instance.config, id)) {
      users.push({ kind: "instance", id: instance.id, name: instance.name });
    }
  }
  for (const theme of Object.values(state.themes)) {
    const { background, fonts } = theme;
    const inBackground =
      (background.type === "image" || background.type === "video") && background.assetId === id;
    const inFonts = Object.values(fonts).some((font) => font?.assetIds?.includes(id));
    if (inBackground || inFonts) users.push({ kind: "theme", id: theme.id, name: theme.name });
  }
  return users;
}
