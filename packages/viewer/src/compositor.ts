import {
  nextBoundary,
  reservedSlots,
  resolveTimelineOnScreen,
  type ShowState,
  sceneBackground,
  type Theme,
  type Timeline,
} from "@storbild/core";
import type { ViewerContext } from "@storbild/plugin-sdk/viewer";
import { css, html, LitElement, type PropertyDeclarations } from "lit";
import { BackgroundLayer } from "./background-layer.ts";
import { renderable } from "./modules.ts";
import { OverlayLayer } from "./overlay-layer.ts";
import { SceneLayer, TRANSITION_MS } from "./scene-layer.ts";
import { fonts, themeVariables } from "./theme.ts";

/** The longest the compositor waits before resolving the timeline again. */
const MAX_WAIT_MS = 60_000;

/**
 * Renders a show state on a 1920×1080 canvas (DESIGN.md §7). Layers, bottom to top: theme
 * background, main scene, overlay slots, interrupt, blackout. Beneath the interrupt, a dim
 * hides what is below, or the scene and overlays fade out so the theme background covers them,
 * as its `below` asks (ADR 0008, ADR 0014). The admin preview (M5) reuses it, fed from its own
 * stream.
 *
 * The active theme (ADR 0014) sets the CSS variables on the host, the background and the
 * custom CSS. It takes effect only once its fonts have loaded, so no fallback font is seen:
 * until then the previous theme stays, and before the first one nothing is shown. A scene
 * that draws its own background, or has one of its own, fades the theme background out.
 *
 * A screen that has lost the server says so in a small pill at the bottom right of the safe
 * area, above everything but the blackout, when `offline` holds its text (ADR 0019). The
 * admin preview never sets it.
 *
 * What is on air comes from `resolveTimeline(state, serverNow())`, not from the server's
 * `timeline`, and is resolved again at the next boundary. So the screen switches at
 * `next.startsAt` even when the patch is late, and keeps the rotation going without one
 * (ADR 0006). A clock that trails the server's a little doesn't see a gap before a fresh
 * anchor (ADR 0013).
 */
export class Compositor extends LitElement {
  static override properties: PropertyDeclarations = {
    state: { attribute: false },
    ctx: { attribute: false },
    offline: { attribute: false },
  };

  static override styles = css`
    :host {
      position: relative;
      display: block;
      width: 1920px;
      height: 1080px;
      overflow: hidden;
      contain: strict;
    }
    .layer,
    .scene {
      position: absolute;
      inset: 0;
    }
    .scene > * {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    .background,
    .main,
    .overlays {
      transition: opacity var(--sb-compositor-transition) ease-in-out;
    }
    .background.off,
    .main.off,
    .overlays.off {
      opacity: 0;
    }
    .backdrop,
    .backdrop > *,
    .backdrop-scene {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    .backdrop {
      transition: background-color var(--sb-compositor-transition) ease-in-out;
    }
    .backdrop > video {
      object-fit: cover;
    }
    .backdrop-dim {
      background: #000;
      opacity: 0;
    }
    .dim,
    .blackout {
      background: #000;
      opacity: 0;
      pointer-events: none;
      transition: opacity var(--sb-compositor-transition) ease-in-out;
    }
    .dim.on {
      opacity: 0.75;
    }
    .blackout.on {
      opacity: 1;
    }

    /* Overlay slots (ADR 0012): bars span the top and bottom, the other eight slots sit in a
       3×3 grid between them with an empty centre. Each slot stacks toward the centre. */
    .overlays {
      box-sizing: border-box;
      padding: var(--sb-safe-area);
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      grid-template-rows: auto auto minmax(0, 1fr) auto auto;
      grid-template-areas:
        "top-bar top-bar top-bar"
        "top-left top top-right"
        "left . right"
        "bottom-left bottom bottom-right"
        "bottom-bar bottom-bar bottom-bar";
      column-gap: var(--sb-gap);
      pointer-events: none;
    }
    .slot {
      display: flex;
      flex-direction: column;
      gap: var(--sb-gap);
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }
    .slot.top-bar,
    .slot.bottom-bar {
      max-height: 240px;
      align-items: stretch;
    }
    .slot.top-bar:has(> .shown) {
      padding-bottom: var(--sb-gap);
    }
    .slot.bottom-bar:has(> .shown) {
      padding-top: var(--sb-gap);
    }
    .slot.bottom-bar,
    .slot.bottom-left,
    .slot.bottom-right {
      flex-direction: column-reverse;
    }
    .slot.top-left,
    .slot.left,
    .slot.bottom-left {
      align-items: flex-start;
      max-width: 640px;
    }
    .slot.top-right,
    .slot.right,
    .slot.bottom-right {
      align-items: flex-end;
      justify-self: end;
      max-width: 640px;
    }
    .slot.left,
    .slot.right {
      justify-content: center;
    }
    .slot.top,
    .slot.bottom {
      flex-direction: row;
      justify-content: center;
      max-height: 240px;
    }
    .slot.top {
      align-items: flex-start;
    }
    .slot.bottom {
      align-items: flex-end;
    }
    .slot.bottom-left,
    .slot.bottom,
    .slot.bottom-right {
      align-self: end;
    }
    .widget {
      min-width: 0;
      max-width: 100%;
    }

    .offline {
      box-sizing: border-box;
      display: flex;
      align-items: flex-end;
      justify-content: flex-end;
      padding: var(--sb-safe-area, 96px);
      opacity: 0;
      pointer-events: none;
      transition: opacity 600ms ease-in-out;
    }
    .offline.on {
      opacity: 1;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 14px;
      padding: 10px 22px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--sb-color-surface, #1a1a1a) 80%, transparent);
      color: var(--sb-color-muted, #a0a0a0);
      font-family: var(--sb-font-body, sans-serif);
      font-size: 24px;
      line-height: 1.2;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .pill::before {
      content: "";
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: currentColor;
    }
  `;

  declare state: ShowState | undefined;
  declare ctx: ViewerContext;
  /** The offline indicator's text, while the screen has lost the server. */
  declare offline: string | undefined;

  #background: BackgroundLayer | undefined;
  #main: SceneLayer | undefined;
  #interrupt: SceneLayer | undefined;
  #overlays: OverlayLayer | undefined;
  #timeline: Timeline | undefined;
  #timer: number | undefined;
  /** The theme on screen, whose fonts have loaded. */
  #theme: Theme | undefined;
  #customCss: CSSStyleSheet | undefined;
  #customCssText = "";
  /** The indicator's last text, kept while it fades out. */
  #offlineText = "";

  protected override willUpdate() {
    const { state, ctx } = this;
    // The fades of the layers, the dim and blackout follow the show's setting.
    const fadeMs = state?.settings?.transitionMs ?? TRANSITION_MS;
    this.style.setProperty("--sb-compositor-transition", `${fadeMs}ms`);
    const wanted = state?.themes[state.activeThemeId];
    if (wanted && ctx) {
      if (fonts.ready(wanted)) this.#theme = wanted;
      else void fonts.ensure(wanted, ctx.assetUrl).then(() => this.requestUpdate());
    }
    if (this.#theme) {
      for (const [name, value] of Object.entries(themeVariables(this.#theme))) {
        this.style.setProperty(name, value);
      }
    }
    const now = ctx?.serverNow();
    this.#timeline = state && now !== undefined ? resolveTimelineOnScreen(state, now) : undefined;
    this.#arm(this.#timeline, now);
  }

  override render() {
    const { state } = this;
    const timeline = this.#timeline;
    const below = timeline?.interrupt?.below;
    // With `below: "hide"`, the scene and overlays fade out and the theme background shows
    // again, even beneath a scene with its own background (ADR 0014).
    const covered = below === "hide";
    const main = timeline?.main?.instanceId;
    if (this.offline) this.#offlineText = this.offline;
    const offline = this.offline !== undefined && !timeline?.blackout;
    const ownBackground =
      state !== undefined &&
      main !== undefined &&
      renderable(state, main) !== undefined &&
      sceneBackground(state, main) !== "theme";
    return html`
      <div class="layer background ${ownBackground && !covered ? "off" : ""}"></div>
      <div class="layer main ${covered ? "off" : ""}" part="main"></div>
      <div class="layer overlays ${covered ? "off" : ""}" part="overlays"></div>
      <div class="layer dim ${below === "dim" ? "on" : ""}"></div>
      <div class="layer interrupt" part="interrupt"></div>
      <div class="layer offline ${offline ? "on" : ""}" part="offline">
        <span class="pill">${this.#offlineText}</span>
      </div>
      <div class="layer blackout ${timeline?.blackout ? "on" : ""}" part="blackout"></div>
    `;
  }

  protected override updated() {
    const root = this.renderRoot;
    this.#background ??= new BackgroundLayer(root.querySelector(".background") as HTMLElement);
    this.#main ??= new SceneLayer(root.querySelector(".main") as HTMLElement);
    this.#interrupt ??= new SceneLayer(root.querySelector(".interrupt") as HTMLElement);
    this.#overlays ??= new OverlayLayer(root.querySelector(".overlays") as HTMLElement);
    const { state, ctx } = this;
    const timeline = this.#timeline;
    const theme = this.#theme;
    // Nothing is shown before the first theme's fonts are ready.
    if (!state || !ctx || !timeline || !theme) return;
    this.#applyCustomCss(theme.customCss ?? "");
    const { main, next, interrupt } = timeline;
    this.#background.update(state, ctx, theme.background);
    this.#main.update(state, ctx, main?.instanceId, next?.instanceId);
    this.#interrupt.update(state, ctx, interrupt?.instanceId);
    this.#overlays.update(state, ctx, reservedSlots(state, timeline));
  }

  /**
   * The theme's custom CSS, in this shadow root after the compositor's own styles. It reaches
   * the layers, inherited properties and parts plugins expose, never the page around a preview.
   */
  #applyCustomCss(text: string) {
    const root = this.renderRoot as ShadowRoot;
    if (!this.#customCss) {
      this.#customCss = new CSSStyleSheet();
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, this.#customCss];
    }
    if (this.#customCssText !== text) {
      this.#customCssText = text;
      try {
        this.#customCss.replaceSync(text);
      } catch (error) {
        console.error("the theme's custom CSS is invalid", error);
      }
    }
  }

  /** Resolves again when the timeline next changes. */
  #arm(timeline: Timeline | undefined, now: number | undefined) {
    window.clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!timeline || now === undefined || !this.isConnected) return;
    const at = nextBoundary(timeline) ?? now + MAX_WAIT_MS;
    // A timer that fires early, e.g. while the clock slews, just resolves the same and re-arms.
    this.#timer = window.setTimeout(
      () => this.requestUpdate(),
      Math.min(Math.max(at - now, 0), MAX_WAIT_MS),
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#background?.dispose();
    this.#main?.dispose();
    this.#interrupt?.dispose();
    this.#overlays?.dispose();
    // Reconnecting creates new layers on the next update.
    this.#background = this.#main = this.#interrupt = this.#overlays = undefined;
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) this.requestUpdate();
  }
}

customElements.define("sb-compositor", Compositor);
