import { nextBoundary, resolveTimeline, type ShowState, type Timeline } from "@storbild/core";
import type { ViewerContext } from "@storbild/plugin-sdk/viewer";
import { css, html, LitElement, type PropertyDeclarations } from "lit";
import { SceneLayer, TRANSITION_MS } from "./scene-layer.ts";

/** The background colour until themes have more than a colour (M7). */
function backgroundOf(state: ShowState | undefined): string {
  const background = state?.themes[state.activeThemeId]?.background;
  return background?.type === "color" ? background.color : "#000";
}

/** The longest the compositor waits before resolving the timeline again. */
const MAX_WAIT_MS = 60_000;

/**
 * Renders a show state on a 1920×1080 canvas (DESIGN.md §7). Layers, bottom to top: theme
 * background, main scene, overlay slots (M8), interrupt, blackout. Beneath the interrupt, a
 * dim or a cover of the theme background hides what is below, as its `below` asks (ADR 0008). The admin preview (M5) reuses it, fed from its own stream.
 *
 * What is on air comes from `resolveTimeline(state, serverNow())`, not from the server's
 * `timeline`, and is resolved again at the next boundary. So the screen switches at
 * `next.startsAt` even when the patch is late, and keeps the rotation going without one
 * (ADR 0006).
 */
export class Compositor extends LitElement {
  static override properties: PropertyDeclarations = {
    state: { attribute: false },
    ctx: { attribute: false },
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
      width: 100%;
      height: 100%;
    }
    .background {
      transition: background-color ${TRANSITION_MS}ms ease-in-out;
    }
    .dim,
    .cover,
    .blackout {
      background: #000;
      opacity: 0;
      pointer-events: none;
      transition: opacity ${TRANSITION_MS}ms ease-in-out;
    }
    .dim.on {
      opacity: 0.75;
    }
    .cover.on {
      opacity: 1;
    }
    .blackout.on {
      opacity: 1;
    }
  `;

  declare state: ShowState | undefined;
  declare ctx: ViewerContext;

  #main: SceneLayer | undefined;
  #interrupt: SceneLayer | undefined;
  #timeline: Timeline | undefined;
  #timer: number | undefined;

  protected override willUpdate() {
    const { state, ctx } = this;
    const now = ctx?.serverNow();
    this.#timeline = state && now !== undefined ? resolveTimeline(state, now) : undefined;
    this.#arm(this.#timeline, now);
  }

  override render() {
    const timeline = this.#timeline;
    const below = timeline?.interrupt?.below;
    return html`
      <div class="layer background" style="background-color: ${backgroundOf(this.state)}"></div>
      <div class="layer main" part="main"></div>
      <div class="layer overlays" part="overlays"></div>
      <div class="layer dim ${below === "dim" ? "on" : ""}"></div>
      <div
        class="layer cover ${below === "hide" ? "on" : ""}"
        style="background-color: ${backgroundOf(this.state)}"
      ></div>
      <div class="layer interrupt" part="interrupt"></div>
      <div class="layer blackout ${timeline?.blackout ? "on" : ""}" part="blackout"></div>
    `;
  }

  protected override updated() {
    const root = this.renderRoot;
    this.#main ??= new SceneLayer(root.querySelector(".main") as HTMLElement);
    this.#interrupt ??= new SceneLayer(root.querySelector(".interrupt") as HTMLElement);
    const { state, ctx } = this;
    const timeline = this.#timeline;
    if (!state || !ctx || !timeline) return;
    const { main, next, interrupt } = timeline;
    this.#main.update(state, ctx, main?.instanceId, next?.instanceId);
    this.#interrupt.update(state, ctx, interrupt?.instanceId);
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
    this.#main?.dispose();
    this.#interrupt?.dispose();
    // Reconnecting creates new layers on the next update.
    this.#main = this.#interrupt = undefined;
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) this.requestUpdate();
  }
}

customElements.define("sb-compositor", Compositor);
