import { type OverlaySlot, overlaySlotSchema, type ShowState } from "@storbild/core";
import { STALE_EVENT, type ViewerContext } from "@storbild/plugin-sdk/viewer";
import {
  assign,
  createSceneElement,
  type Renderable,
  renderable,
  type SceneElement,
  withTimeout,
} from "./modules.ts";
import { TRANSITION_MS } from "./scene-layer.ts";

export interface OverlayLayerOptions {
  /** How long `prepare()` (and loading the module) may take before the widget is shown anyway. */
  prepareTimeoutMs?: number;
  log?: (message: string, error?: unknown) => void;
}

/** A placed widget, from the moment it starts loading until it is removed. */
interface Widget {
  key: string;
  wrapper: HTMLElement;
  element?: SceneElement;
  /** Loaded and prepared. */
  ready: boolean;
  /** Placed, visible and renderable; once false the widget fades out and is removed. */
  placed: boolean;
  /** Showing, or fading in. */
  shown: boolean;
  /** On screen: from the start of its fade-in to the end of its fade-out (ADR 0030). */
  onScreen: boolean;
  animation?: Animation | undefined;
  disposed: boolean;
}

/**
 * The overlay slots of the compositor (DESIGN.md §4.5, ADR 0012). Each slot is a flex stack in
 * the slot grid, and each widget sits in a wrapper whose CSS `order` is its placement's order.
 *
 * A widget is shown while it is placed and visible, isn't stale, and no current scene reserves
 * its slot. Hiding fades it out and then takes it out of the flow, so the stack closes the gap.
 * Widgets are keyed by instance ID and stay mounted while they are only reserved or stale; one
 * that is unplaced or hidden in the admin is removed after its fade.
 *
 * A widget that can't be rendered is left out. Plugin errors are logged and never escape.
 */
export class OverlayLayer {
  readonly #slots = new Map<OverlaySlot, HTMLElement>();
  readonly #widgets = new Map<string, Widget>();
  readonly #prepareTimeoutMs: number;
  readonly #log: (message: string, error?: unknown) => void;

  #state: ShowState | undefined;
  #ctx: ViewerContext | undefined;
  #reserved: ReadonlySet<OverlaySlot> = new Set();
  /** Whether the compositor shows this layer (ADR 0030). */
  #visible = true;

  constructor(container: HTMLElement, options: OverlayLayerOptions = {}) {
    this.#prepareTimeoutMs = options.prepareTimeoutMs ?? 10_000;
    this.#log = options.log ?? ((message, error) => console.error(message, error ?? ""));
    for (const slot of overlaySlotSchema.options) {
      const element = document.createElement("div");
      element.className = `slot ${slot}`;
      element.dataset.slot = slot;
      element.style.gridArea = slot;
      container.append(element);
      this.#slots.set(slot, element);
    }
  }

  /** Shows the state's placed widgets, except those in `reserved` slots. */
  update(state: ShowState, ctx: ViewerContext, reserved: ReadonlySet<OverlaySlot>) {
    this.#state = state;
    this.#ctx = ctx;
    this.#reserved = reserved;

    const wanted = new Set<string>();
    for (const placement of state.overlays) {
      const scene = placement.visible ? overlay(state, placement.instanceId) : undefined;
      if (!scene) continue;
      wanted.add(placement.instanceId);
      // A widget still fading out after removal fades back in.
      const widget =
        this.#widgets.get(placement.instanceId) ?? this.#mount(placement.instanceId, scene);
      widget.placed = true;
      const slot = this.#slots.get(placement.slot);
      if (slot && widget.wrapper.parentElement !== slot) slot.append(widget.wrapper);
      widget.wrapper.dataset.slot = placement.slot;
      widget.wrapper.style.order = String(placement.order);
      widget.wrapper.classList.toggle("framed", scene.type.frame !== false);
      if (widget.element) this.#assign(widget.element, scene);
    }
    for (const widget of [...this.#widgets.values()]) {
      if (!wanted.has(widget.key)) widget.placed = false;
      this.#refresh(widget);
    }
  }

  /**
   * Whether the layer can be seen, from the compositor: `true` as it starts to fade in,
   * `false` once it has faded out (ADR 0030). Widgets on screen follow it.
   */
  setVisible(visible: boolean) {
    this.#visible = visible;
    for (const widget of this.#widgets.values()) this.#setVisible(widget);
  }

  #setVisible(widget: Widget) {
    const { element } = widget;
    const visible = this.#visible && widget.onScreen;
    if (element) {
      this.#safely("update", () => {
        element.visible = visible;
      });
    }
  }

  /** Removes every widget and the slots. */
  dispose() {
    for (const widget of [...this.#widgets.values()]) this.#unmount(widget);
    for (const slot of this.#slots.values()) slot.remove();
  }

  #mount(key: string, scene: Renderable): Widget {
    const wrapper = document.createElement("div");
    wrapper.className = "widget";
    wrapper.dataset.widget = key;
    wrapper.dataset.phase = "preparing";
    wrapper.style.display = "none";
    wrapper.style.opacity = "0";
    const widget: Widget = {
      key,
      wrapper,
      ready: false,
      placed: true,
      shown: false,
      onScreen: false,
      disposed: false,
    };
    this.#widgets.set(key, widget);
    wrapper.addEventListener(STALE_EVENT, () => this.#refresh(widget));
    void this.#load(widget, scene);
    return widget;
  }

  /** Loads the module, creates the element in its (hidden) wrapper and prepares it. */
  async #load(widget: Widget, scene: Renderable) {
    const ctx = this.#ctx;
    if (!ctx) return;
    let element: SceneElement;
    try {
      element = await createSceneElement(scene, ctx, this.#prepareTimeoutMs);
    } catch (error) {
      this.#log(`cannot show overlay ${widget.key}`, error);
      // Forgotten, so the next update tries again.
      this.#unmount(widget);
      return;
    }
    if (widget.disposed) return;
    widget.element = element;
    widget.wrapper.append(element);
    // The data may have changed while the module loaded.
    const current = this.#state && overlay(this.#state, widget.key);
    if (current) this.#assign(element, current);
    try {
      await withTimeout(
        (async () => {
          await element.updateComplete;
          await element.prepare();
        })(),
        this.#prepareTimeoutMs,
        `preparing overlay ${widget.key}`,
      );
    } catch (error) {
      this.#log(`prepare() failed for overlay ${widget.key}; showing it anyway`, error);
    }
    if (widget.disposed) return;
    widget.ready = true;
    widget.wrapper.dataset.phase = "ready";
    this.#refresh(widget);
  }

  /** Fades the widget in or out as its placement, slot and data ask. */
  #refresh(widget: Widget) {
    if (widget.disposed) return;
    const slot = widget.wrapper.dataset.slot as OverlaySlot | undefined;
    const stale = (widget.element as { stale?: unknown } | undefined)?.stale === true;
    const show =
      widget.placed && widget.ready && !stale && slot !== undefined && !this.#reserved.has(slot);
    if (show === widget.shown) {
      if (!show && !widget.placed && !widget.animation) this.#unmount(widget);
      return;
    }
    widget.shown = show;
    const at = this.#ctx?.serverNow() ?? Date.now();
    const { element, wrapper } = widget;
    if (show) {
      wrapper.style.display = "";
      wrapper.classList.add("shown");
      wrapper.dataset.phase = "in";
      widget.onScreen = true;
      this.#setVisible(widget);
      if (element) this.#safely("enter", () => element.enter(at));
      this.#fade(widget, 1).finished.then(
        () => {
          if (widget.shown) wrapper.dataset.phase = "shown";
        },
        () => {},
      );
    } else {
      wrapper.dataset.phase = "out";
      if (element) this.#safely("exit", () => element.exit(at));
      this.#fade(widget, 0).finished.then(
        () => {
          widget.animation = undefined;
          if (widget.shown) return;
          widget.onScreen = false;
          this.#setVisible(widget);
          wrapper.style.display = "none";
          wrapper.classList.remove("shown");
          wrapper.dataset.phase = "hidden";
          if (!widget.placed) this.#unmount(widget);
        },
        () => {},
      );
    }
  }

  #fade(widget: Widget, to: 0 | 1): Animation {
    const { wrapper } = widget;
    const from = Number(getComputedStyle(wrapper).opacity);
    widget.animation?.cancel();
    wrapper.style.opacity = String(to);
    const fadeMs = this.#state?.settings?.transitionMs ?? TRANSITION_MS;
    widget.animation = wrapper.animate([{ opacity: from }, { opacity: to }], {
      duration: fadeMs * Math.abs(to - from),
      easing: "ease-in-out",
    });
    return widget.animation;
  }

  #assign(element: SceneElement, scene: Renderable) {
    const ctx = this.#ctx;
    if (ctx) this.#safely("update", () => assign(element, scene, ctx));
  }

  #unmount(widget: Widget) {
    if (widget.disposed) return;
    widget.disposed = true;
    widget.animation?.cancel();
    if (this.#widgets.get(widget.key) === widget) this.#widgets.delete(widget.key);
    const { element } = widget;
    if (element) this.#safely("dispose", () => element.dispose());
    widget.wrapper.remove();
  }

  #safely(what: string, fn: () => void) {
    try {
      fn();
    } catch (error) {
      this.#log(`overlay ${what} failed`, error);
    }
  }
}

/** An overlay instance that can be rendered. */
function overlay(state: ShowState, instanceId: string): Renderable | undefined {
  const scene = renderable(state, instanceId);
  return scene?.type.kind === "overlay" ? scene : undefined;
}
