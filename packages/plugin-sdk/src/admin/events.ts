// The admin's public types and the events it answers for the form components.
import type { AssetMeta, Issue } from "@storbild/core";
import type { JsonSchema } from "../form-model.ts";

/** Fired by `<sb-field>` and `<sb-form>` with the whole new value; `undefined` means left out. */
export type ValueChangeEvent = CustomEvent<{ value: unknown }>;

/**
 * What the admin sets on a plugin's custom editor element (the type's `editor`), which lives in
 * the plugin's `storbild.admin` module. The editor fires a `change` `ValueChangeEvent` with the
 * whole config on every edit; the admin validates it on the server when it is saved.
 */
export interface EditorProperties<Config = unknown, Settings = unknown> {
  value: Config;
  /** The config's JSON Schema, for editors that render parts of it with `<sb-form>`. */
  schema: JsonSchema;
  /** The plugin's current settings. */
  settings: Settings;
  /** Validation issues from the last save, with paths into the config. */
  issues: Issue[];
}

/**
 * The show's uploaded files, as the admin offers them to asset fields. The admin answers an
 * `AssetSourceRequest` with one; a custom editor never needs to, as `<sb-field>` asks itself.
 */
export interface AssetSource {
  /** The show's assets. */
  list(): AssetMeta[];
  /** The asset's file. */
  url(id: string): string;
  /** A small image for a list: the thumbnail, or the file itself when there is none. */
  previewUrl(id: string): string;
  /** Uploads a file and resolves to its asset, or rejects with a message to show. */
  upload(file: File): Promise<AssetMeta>;
  /** Calls `callback` when the assets change. Returns a function that stops it. */
  subscribe(callback: () => void): () => void;
}

/**
 * Fired (bubbling, composed) by an asset picker when it connects. The admin sets
 * `detail.source`.
 */
export type AssetSourceRequest = CustomEvent<{ source?: AssetSource }>;
export const ASSET_SOURCE_REQUEST = "sb-asset-source";

/**
 * Fired (bubbling, composed) by a date-time field to turn an offset like "45 minutes from now"
 * into a time. The admin sets `detail.now` to its server clock.
 */
export type ClockRequest = CustomEvent<{ now?: () => number }>;
export const CLOCK_REQUEST = "sb-clock";
