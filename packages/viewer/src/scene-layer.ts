import type { ShowState } from "@storbild/core";
import type { ViewerContext } from "@storbild/plugin-sdk/viewer";
import {
  assign,
  createSceneElement,
  renderable,
  type SceneElement,
  withTimeout,
} from "./modules.ts";

/** Crossfade length for a state without settings; shows set it in `settings.transitionMs`. */
export const TRANSITION_MS = 800;

export interface SceneLayerOptions {
  /** Fixes the crossfade length; by default it follows the state's `settings.transitionMs`. */
  transitionMs?: number;
  /** How long `prepare()` (and loading the module) may take before the scene is shown anyway. */
  prepareTimeoutMs?: number;
  log?: (message: string, error?: unknown) => void;
}

/** A scene element in the layer, inside a wrapper the layer fades. */
interface Mounted {
  key: string;
  element: SceneElement;
  wrapper: HTMLElement;
  animation?: Animation;
  disposed?: boolean;
}

/** A scene being loaded and prepared, before it is shown. */
interface Preparing {
  key: string;
  ready: Promise<Mounted | undefined>;
  mounted?: Mounted;
  cancelled: boolean;
}

/**
 * One compositor layer that shows at most one scene at a time (DESIGN.md §7, ADR 0005).
 *
 * Scenes are keyed by instance ID: while the same instance stays on air, its element is kept
 * and only its properties change. A new scene is mounted invisibly, prepared, and crossfaded
 * in. At most two scenes are visible: a change during a fade removes the outgoing scene at
 * once. The next scene is prefetched, mounted hidden and prepared, while no fade runs.
 *
 * A scene that can't be rendered (broken, unknown, failed to load) leaves the layer empty, so
 * the layers below show through. Plugin errors are logged and never escape.
 */
export class SceneLayer {
  readonly #container: HTMLElement;
  readonly #transitionMs: number | undefined;
  readonly #prepareTimeoutMs: number;
  readonly #log: (message: string, error?: unknown) => void;

  #state: ShowState | undefined;
  #ctx: ViewerContext | undefined;
  #target: string | undefined;
  #next: string | undefined;

  #current: Mounted | undefined;
  #outgoing: Mounted | undefined;
  #incoming: Preparing | undefined;
  #prefetch: Preparing | undefined;
  /** A target that failed to load; retried on the next update rather than in a loop. */
  #failed: string | undefined;

  constructor(container: HTMLElement, options: SceneLayerOptions = {}) {
    this.#container = container;
    this.#transitionMs = options.transitionMs;
    this.#prepareTimeoutMs = options.prepareTimeoutMs ?? 10_000;
    this.#log = options.log ?? ((message, error) => console.error(message, error ?? ""));
  }

  /** Shows `target` (an instance ID, or nothing) and prefetches `next`. */
  update(state: ShowState, ctx: ViewerContext, target?: string, next?: string) {
    this.#state = state;
    this.#ctx = ctx;
    this.#target = target && renderable(state, target) ? target : undefined;
    this.#next = next && renderable(state, next) ? next : undefined;
    this.#failed = undefined;
    for (const mounted of [
      this.#current,
      this.#outgoing,
      this.#incoming?.mounted,
      this.#prefetch?.mounted,
    ]) {
      if (mounted) this.#assign(mounted);
    }
    this.#reconcile();
  }

  #fadeMs(): number {
    return this.#transitionMs ?? this.#state?.settings?.transitionMs ?? TRANSITION_MS;
  }

  /** Removes every scene. */
  dispose() {
    for (const preparing of [this.#incoming, this.#prefetch]) {
      if (preparing) this.#cancel(preparing);
    }
    for (const mounted of [this.#current, this.#outgoing]) {
      if (mounted) this.#unmount(mounted);
    }
    this.#incoming = this.#prefetch = this.#current = this.#outgoing = undefined;
  }

  #reconcile() {
    const target = this.#target;
    if (this.#incoming && this.#incoming.key !== target) {
      // A preparing prefetch target that is no longer wanted is cancelled like any other.
      this.#cancel(this.#incoming);
      this.#incoming = undefined;
    }
    if (!this.#incoming && target !== this.#current?.key) {
      if (target === undefined) {
        this.#show(undefined);
      } else if (target === this.#failed) {
        // Retried on the next update.
      } else if (this.#prefetch?.key === target) {
        this.#begin(this.#prefetch);
        this.#prefetch = undefined;
      } else {
        this.#begin(this.#prepare(target));
      }
    }

    const next = this.#next;
    if (this.#prefetch && this.#prefetch.key !== next) {
      this.#cancel(this.#prefetch);
      this.#prefetch = undefined;
    }
    if (
      next !== undefined &&
      !this.#prefetch &&
      !this.#outgoing &&
      !this.#incoming &&
      next !== this.#current?.key
    ) {
      this.#prefetch = this.#prepare(next);
    }
  }

  #begin(preparing: Preparing) {
    this.#incoming = preparing;
    void preparing.ready.then((mounted) => {
      if (this.#incoming !== preparing || preparing.cancelled) return;
      this.#incoming = undefined;
      if (!mounted) this.#failed = preparing.key;
      this.#show(mounted);
    });
  }

  /** Crossfades from the current scene to `mounted`, or to nothing. */
  #show(mounted: Mounted | undefined) {
    const at = this.#ctx?.serverNow() ?? Date.now();
    if (this.#outgoing) this.#unmount(this.#outgoing);
    const old = this.#current;
    this.#current = mounted;
    this.#outgoing = old;

    if (old) {
      old.wrapper.dataset.phase = "out";
      this.#safely("exit", () => old.element.exit(at));
      this.#fade(old, 0).finished.then(
        () => {
          if (this.#outgoing === old) this.#outgoing = undefined;
          this.#unmount(old);
          this.#reconcile();
        },
        () => {},
      );
    }
    if (mounted) {
      mounted.wrapper.dataset.phase = "in";
      this.#safely("enter", () => mounted.element.enter(at));
      this.#fade(mounted, 1).finished.then(
        () => {
          if (this.#current === mounted) mounted.wrapper.dataset.phase = "current";
        },
        () => {},
      );
    }
    this.#reconcile();
  }

  #fade(mounted: Mounted, to: 0 | 1): Animation {
    const from = Number(getComputedStyle(mounted.wrapper).opacity);
    mounted.animation?.cancel();
    mounted.wrapper.style.opacity = String(to);
    mounted.animation = mounted.wrapper.animate([{ opacity: from }, { opacity: to }], {
      duration: this.#fadeMs() * Math.abs(to - from),
      easing: "ease-in-out",
    });
    return mounted.animation;
  }

  /** Loads, mounts (invisibly) and prepares a scene. */
  #prepare(key: string): Preparing {
    const preparing: Preparing = { key, cancelled: false, ready: Promise.resolve(undefined) };
    preparing.ready = (async () => {
      const scene = this.#state && renderable(this.#state, key);
      const ctx = this.#ctx;
      if (!scene || !ctx) return undefined;
      let element: SceneElement;
      try {
        element = await createSceneElement(scene, ctx, this.#prepareTimeoutMs);
      } catch (error) {
        this.#log(`cannot show instance ${key}`, error);
        return undefined;
      }
      if (preparing.cancelled) return undefined;

      const wrapper = document.createElement("div");
      wrapper.className = "scene";
      wrapper.dataset.scene = key;
      wrapper.dataset.phase = "preparing";
      wrapper.style.opacity = "0";
      wrapper.append(element);
      this.#container.append(wrapper);
      const mounted: Mounted = { key, element, wrapper };
      preparing.mounted = mounted;
      // The data may have changed while the module loaded.
      this.#assign(mounted);

      try {
        await withTimeout(
          (async () => {
            await element.updateComplete;
            await element.prepare();
          })(),
          this.#prepareTimeoutMs,
          `preparing instance ${key}`,
        );
      } catch (error) {
        // Better to show a scene that isn't fully ready than nothing.
        this.#log(`prepare() failed for instance ${key}; showing it anyway`, error);
      }
      if (preparing.cancelled) {
        this.#unmount(mounted);
        return undefined;
      }
      wrapper.dataset.phase = "ready";
      return mounted;
    })();
    return preparing;
  }

  #cancel(preparing: Preparing) {
    preparing.cancelled = true;
    if (preparing.mounted) this.#unmount(preparing.mounted);
  }

  #assign(mounted: Mounted) {
    const scene = this.#state && renderable(this.#state, mounted.key);
    const ctx = this.#ctx;
    if (scene && ctx) this.#safely("update", () => assign(mounted.element, scene, ctx));
  }

  #unmount(mounted: Mounted) {
    if (mounted.disposed) return;
    mounted.disposed = true;
    mounted.animation?.cancel();
    this.#safely("dispose", () => mounted.element.dispose());
    mounted.wrapper.remove();
  }

  #safely(what: string, fn: () => void) {
    try {
      fn();
    } catch (error) {
      this.#log(`scene ${what} failed`, error);
    }
  }
}
