import type { Instance, PluginTypeInfo, ShowState } from "@storbild/core";
import type { StorbildElement, ViewerContext } from "@storbild/plugin-sdk/viewer";

/** A plugin element as the compositor sees it. */
export type SceneElement = StorbildElement<unknown, unknown, unknown, unknown>;

/** Everything needed to render an instance, or undefined when it can't be rendered. */
export interface Renderable {
  instance: Instance;
  module: string;
  settings: unknown;
  pluginState: unknown;
  type: PluginTypeInfo;
}

export function renderable(state: ShowState, instanceId: string): Renderable | undefined {
  const instance = state.instances[instanceId];
  if (!instance || instance.error !== undefined) return undefined;
  const plugin = state.plugins[instance.plugin];
  const type = plugin?.types[instance.type];
  if (!plugin?.module || !type) return undefined;
  return {
    instance,
    module: plugin.module,
    settings: plugin.settings,
    pluginState: plugin.state,
    type,
  };
}

const modules = new Map<string, Promise<void>>();
/** The module URL that defined each custom element in use. */
const definedBy = new Map<string, string>();

/**
 * Whether a plugin in use now has another module URL, for example after an upgrade. Custom
 * elements can't be redefined, so only a page reload picks the new version up.
 */
export function hasStaleModules(state: ShowState): boolean {
  for (const plugin of Object.values(state.plugins)) {
    for (const type of Object.values(plugin.types)) {
      const url = definedBy.get(type.viewer);
      if (url !== undefined && plugin.module !== undefined && url !== plugin.module) return true;
    }
  }
  return false;
}

/**
 * Imports a plugin's browser module once. A failure is forgotten, so the next attempt (on a
 * later state change) retries, for example after an outage.
 */
function loadModule(url: string): Promise<void> {
  let loading = modules.get(url);
  if (!loading) {
    loading = import(url).then(() => undefined);
    loading.catch(() => modules.delete(url));
    modules.set(url, loading);
  }
  return loading;
}

/** Settles like `promise`, or rejects after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Copies an instance's data onto its element. Lit re-renders only what changed. */
export function assign(element: SceneElement, scene: Renderable, ctx: ViewerContext) {
  element.config = scene.instance.config;
  element.settings = scene.settings;
  element.state = scene.instance.state;
  element.pluginState = scene.pluginState;
  element.ctx = ctx;
}

/**
 * Loads the plugin module and creates the instance's element, with its properties set. Rejects
 * when the module fails to load or never defines the element.
 */
export async function createSceneElement(
  scene: Renderable,
  ctx: ViewerContext,
  timeoutMs = 10_000,
): Promise<SceneElement> {
  const tag = scene.type.viewer;
  await withTimeout(
    loadModule(scene.module).then(() => customElements.whenDefined(tag)),
    timeoutMs,
    `loading <${tag}> from ${scene.module}`,
  );
  if (!definedBy.has(tag)) definedBy.set(tag, scene.module);
  const element = document.createElement(tag) as SceneElement;
  // Hidden until its layer shows it (ADR 0030).
  element.visible = false;
  assign(element, scene, ctx);
  return element;
}
