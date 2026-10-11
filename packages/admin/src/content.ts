// Pure helpers for the content pages (Library, Rotation, Plugins). No DOM, so they're unit-tested.
import type { Instance, InstanceKind, JsonValue, ShowState } from "@storbild/core";

/** An instance type a plugin offers, for the Library's "new instance" choice. */
export interface TypeChoice {
  plugin: string;
  type: string;
  label: string;
  kind: InstanceKind;
  /** A singleton type that already has its one instance. */
  taken: boolean;
}

/** The types instances can be created of: those of plugins that loaded, by label. */
export function typeChoices(state: ShowState): TypeChoice[] {
  const instances = Object.values(state.instances);
  return Object.entries(state.plugins)
    .filter(([, entry]) => entry.status === "ok" || entry.status === "error")
    .flatMap(([plugin, entry]) =>
      Object.entries(entry.types).map(([type, info]) => ({
        plugin,
        type,
        label: info.label,
        kind: info.kind,
        taken:
          info.singleton === true &&
          instances.some((instance) => instance.plugin === plugin && instance.type === type),
      })),
    )
    .sort((a, b) => a.label.localeCompare(b.label) || a.plugin.localeCompare(b.plugin));
}

export interface InstanceGroup {
  /** `plugin/type`. */
  key: string;
  /** The type's label, or the key when the plugin no longer describes it. */
  label: string;
  kind: InstanceKind | undefined;
  instances: Instance[];
}

/** The library grouped by type, groups and instances by name. */
export function groupInstances(state: ShowState): InstanceGroup[] {
  const groups = new Map<string, InstanceGroup>();
  for (const instance of Object.values(state.instances)) {
    const key = `${instance.plugin}/${instance.type}`;
    let group = groups.get(key);
    if (!group) {
      const info = state.plugins[instance.plugin]?.types[instance.type];
      group = { key, label: info?.label ?? key, kind: info?.kind, instances: [] };
      groups.set(key, group);
    }
    group.instances.push(instance);
  }
  const byName = (a: { name?: string; label?: string }, b: { name?: string; label?: string }) =>
    (a.name ?? a.label ?? "").localeCompare(b.name ?? b.label ?? "");
  return [...groups.values()]
    .map((group) => ({ ...group, instances: group.instances.sort(byName) }))
    .sort(byName);
}

/** How many playlist items show the instance. */
export function rotationCount(state: ShowState, instanceId: string): number {
  return state.playlist.items.filter((item) => item.instanceId === instanceId).length;
}

/** The ID the Library preview gives an instance that hasn't been created yet. */
export const DRAFT_ID = "draft";

/**
 * The state the Library preview renders: only `instance` (with its unsaved changes) on air,
 * holding, with nothing over it. The live show's theme and settings still apply.
 */
export function previewState(
  state: ShowState,
  instance: Pick<Instance, "plugin" | "type" | "name"> & { id?: string; config: unknown },
): ShowState {
  const id = instance.id ?? DRAFT_ID;
  const stored = state.instances[id];
  const draft: Instance = {
    configVersion: 1,
    ...stored,
    id,
    plugin: instance.plugin,
    type: instance.type,
    name: instance.name,
    config: (instance.config ?? null) as JsonValue,
  };
  delete draft.error;
  return {
    ...state,
    instances: { ...state.instances, [id]: draft },
    playlist: { items: [], anchorAt: 0 },
    cues: [],
    live: { main: { instanceId: id, startedAt: 0 }, blackout: false },
  };
}

/** Moves the element at `from` to `to`. */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

/** A `datetime-local` value in local time, or "" for none. */
export function toLocalInput(epochMs: number | undefined): string {
  if (epochMs === undefined) return "";
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Epoch ms from a `datetime-local` value; `undefined` when blank or invalid. */
export function fromLocalInput(value: string): number | undefined {
  if (value === "") return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/** Whether two JSON-like values are equal. Key order is ignored. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return (
    ka.length === kb.length &&
    ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}
