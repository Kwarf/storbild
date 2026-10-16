import type { ShowState, ThemeBackground } from "@storbild/core";
import type { ViewerContext } from "@storbild/plugin-sdk/viewer";
import { withTimeout } from "./modules.ts";
import { SceneLayer, TRANSITION_MS } from "./scene-layer.ts";

/** How long a new image or video may take to be ready before it fades in anyway. */
const READY_TIMEOUT_MS = 5_000;

/** One background in the layer. */
interface Mounted {
  key: string;
  element: HTMLElement;
  /** The image or video, beneath its dim. */
  media?: HTMLImageElement | HTMLVideoElement;
  /** The black wash over an image or video; colours and scenes have none. */
  dim?: HTMLElement;
  scene?: SceneLayer;
  disposed?: boolean;
}

/** Backgrounds of the same key are the same thing on screen and are updated in place. */
function keyOf(background: ThemeBackground): string {
  switch (background.type) {
    case "color":
      return "color";
    case "image":
    case "video":
      return `${background.type}:${background.assetId}`;
    case "scene":
      return `scene:${background.instanceId}`;
  }
}

/**
 * Renders a theme background (DESIGN.md §4.6, ADR 0014): a colour, an image or a looping
 * muted video, each with an optional black dim, or a scene instance. A background of the same
 * kind and file is updated in place, so two themes with the same image don't flicker and a
 * colour change fades by CSS. A new image or video fades in over the old one once it is ready.
 */
export class BackgroundLayer {
  readonly #container: HTMLElement;
  #current: Mounted | undefined;
  #outgoing: Mounted | undefined;
  /** Whether the compositor shows this layer (ADR 0030). */
  #visible = true;

  constructor(container: HTMLElement) {
    this.#container = container;
  }

  update(state: ShowState, ctx: ViewerContext, background: ThemeBackground | undefined) {
    const fadeMs = state.settings?.transitionMs ?? TRANSITION_MS;
    const key = background ? keyOf(background) : undefined;
    if (key !== this.#current?.key) {
      const old = this.#current;
      this.#current = background && key ? this.#mount(key, background, ctx) : undefined;
      if (this.#outgoing) this.#unmount(this.#outgoing);
      this.#outgoing = old;
      const incoming = this.#current;
      void this.#ready(incoming).then(() => {
        if (incoming && !incoming.disposed) this.#fade(incoming.element, fadeMs);
        if (old) {
          // The new background covers the old one before it goes.
          window.setTimeout(
            () => {
              if (this.#outgoing === old) this.#outgoing = undefined;
              this.#unmount(old);
            },
            incoming ? fadeMs : 0,
          );
        }
      });
    }
    if (this.#current && background) this.#apply(this.#current, background, state, ctx);
  }

  /**
   * Whether the layer can be seen, from the compositor: `true` as it starts to fade in,
   * `false` once it has faded out (ADR 0030). A scene background follows it, and a video
   * pauses while it is hidden.
   */
  setVisible(visible: boolean) {
    this.#visible = visible;
    for (const mounted of [this.#current, this.#outgoing]) if (mounted) this.#setVisible(mounted);
  }

  #setVisible(mounted: Mounted) {
    mounted.scene?.setVisible(this.#visible);
    const { media } = mounted;
    if (media instanceof HTMLVideoElement) {
      if (!this.#visible) media.pause();
      else if (media.paused) media.play().catch((error) => console.error(error));
    }
  }

  dispose() {
    for (const mounted of [this.#current, this.#outgoing]) if (mounted) this.#unmount(mounted);
    this.#current = this.#outgoing = undefined;
  }

  #mount(key: string, background: ThemeBackground, ctx: ViewerContext): Mounted {
    const element = document.createElement("div");
    element.className = "backdrop";
    element.dataset.background = background.type;
    element.style.opacity = "0";
    const mounted: Mounted = { key, element };
    if (background.type === "image") {
      const img = document.createElement("img");
      img.alt = "";
      img.src = ctx.assetUrl(background.assetId);
      mounted.media = img;
    } else if (background.type === "video") {
      const video = document.createElement("video");
      video.muted = true;
      video.loop = true;
      video.autoplay = this.#visible;
      // Loads ahead even while hidden and not playing, so it is ready to fade in.
      video.preload = "auto";
      video.playsInline = true;
      video.src = ctx.assetUrl(background.assetId);
      mounted.media = video;
    } else if (background.type === "scene") {
      const host = document.createElement("div");
      host.className = "backdrop-scene";
      element.append(host);
      mounted.scene = new SceneLayer(host);
      mounted.scene.setVisible(this.#visible);
    }
    if (mounted.media) {
      const dim = document.createElement("div");
      dim.className = "backdrop-dim";
      element.append(mounted.media, dim);
      mounted.dim = dim;
    }
    this.#container.append(element);
    return mounted;
  }

  #apply(mounted: Mounted, background: ThemeBackground, state: ShowState, ctx: ViewerContext) {
    const { element, media, dim, scene } = mounted;
    element.style.backgroundColor = background.type === "color" ? background.color : "#000";
    if (background.type === "image" && media) media.style.objectFit = background.fit;
    if (background.type === "image" || background.type === "video") {
      if (dim) dim.style.opacity = String(background.dim ?? 0);
    }
    if (background.type === "scene") scene?.update(state, ctx, background.instanceId);
  }

  /** Settles once an image is decoded or a video can play, or after a while regardless. */
  async #ready(mounted: Mounted | undefined) {
    const media = mounted?.media;
    if (!media) return;
    const ready =
      media instanceof HTMLImageElement
        ? media.decode()
        : new Promise<void>((resolve, reject) => {
            if (media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) resolve();
            media.addEventListener("canplay", () => resolve(), { once: true });
            media.addEventListener("error", () => reject(media.error), { once: true });
          });
    await withTimeout(ready, READY_TIMEOUT_MS, "loading the background").catch((error) =>
      console.error(error),
    );
  }

  #fade(element: HTMLElement, fadeMs: number) {
    element.style.opacity = "1";
    element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fadeMs, easing: "ease-in-out" });
  }

  #unmount(mounted: Mounted) {
    if (mounted.disposed) return;
    mounted.disposed = true;
    mounted.scene?.dispose();
    if (mounted.media instanceof HTMLVideoElement) {
      mounted.media.pause();
      mounted.media.removeAttribute("src");
      mounted.media.load();
    }
    mounted.element.remove();
  }
}
