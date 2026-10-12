import type { Instance } from "./schema/instance.ts";
import type { ShowState } from "./schema/state.ts";
import type { Theme } from "./schema/theme.ts";

/** Something in the show that references an asset. */
export interface AssetUser {
  kind: "instance" | "theme";
  id: string;
  name: string;
}

/** Every string anywhere in a JSON value. */
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) strings(item, into);
  }
  return into;
}

/**
 * The asset IDs an instance may use: its background, and every string in its config. Asset IDs
 * are content hashes, so an exact string match in a config needs no schema (ADR 0011).
 */
function instanceCandidates(instance: Instance): string[] {
  const candidates = typeof instance.background === "object" ? [instance.background.assetId] : [];
  return strings(instance.config, candidates);
}

/** The asset IDs a theme uses: its image or video background and its font faces. */
function themeAssets(theme: Theme): string[] {
  const { background, fonts } = theme;
  const ids =
    background.type === "image" || background.type === "video" ? [background.assetId] : [];
  for (const font of Object.values(fonts)) {
    for (const face of font?.faces ?? []) ids.push(face.assetId);
  }
  return ids;
}

/**
 * Lists what references an asset (ADR 0011): instances whose background is the asset or whose
 * config holds its ID as a string anywhere, and themes whose background or fonts use it.
 */
export function assetUsers(state: ShowState, id: string): AssetUser[] {
  const users: AssetUser[] = [];
  for (const instance of Object.values(state.instances)) {
    if (instanceCandidates(instance).includes(id)) {
      users.push({ kind: "instance", id: instance.id, name: instance.name });
    }
  }
  for (const theme of Object.values(state.themes)) {
    if (themeAssets(theme).includes(id)) {
      users.push({ kind: "theme", id: theme.id, name: theme.name });
    }
  }
  return users;
}

/**
 * The assets of the show that something uses, by the rules of `assetUsers`. Screens cache these
 * for outages (ADR 0019); files in the library that nothing uses are left out.
 */
export function referencedAssetIds(state: ShowState): Set<string> {
  const ids = new Set<string>();
  const add = (candidate: string) => {
    if (state.assets[candidate]) ids.add(candidate);
  };
  for (const instance of Object.values(state.instances)) {
    for (const candidate of instanceCandidates(instance)) add(candidate);
  }
  for (const theme of Object.values(state.themes)) {
    for (const candidate of themeAssets(theme)) add(candidate);
  }
  return ids;
}
