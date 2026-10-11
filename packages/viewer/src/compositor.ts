import type { ShowState } from "@storbild/core";
import type { ViewerContext } from "@storbild/plugin-sdk/viewer";
import { css, html, LitElement, type PropertyDeclarations } from "lit";
import { SceneLayer, TRANSITION_MS } from "./scene-layer.ts";

/** The background colour until themes have more than a colour (M7). */
function backgroundOf(state: ShowState | undefined): string {
  const background = state?.themes[state.activeThemeId]?.background;
  return background?.type === "color" ? background.color : "#000";
}

/**
 * Renders a show state on a 1920×1080 canvas (DESIGN.md §7). Layers, bottom to top: theme
 * background, main scene, overlay slots (M8), interrupt (optionally dimming what is below),
 * blackout. The admin preview (M5) reuses it, fed from its own stream.
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
    .blackout {
      background: #000;
      opacity: 0;
      pointer-events: none;
      transition: opacity ${TRANSITION_MS}ms ease-in-out;
    }
    .dim.on {
      opacity: 0.6;
    }
    .blackout.on {
      opacity: 1;
    }
  `;

  declare state: ShowState | undefined;
  declare ctx: ViewerContext;

  #main: SceneLayer | undefined;
  #interrupt: SceneLayer | undefined;

  override render() {
    const timeline = this.state?.timeline;
    return html`
      <div class="layer background" style="background-color: ${backgroundOf(this.state)}"></div>
      <div class="layer main" part="main"></div>
      <div class="layer overlays" part="overlays"></div>
      <div class="layer dim ${timeline?.interrupt?.dimBelow ? "on" : ""}"></div>
      <div class="layer interrupt" part="interrupt"></div>
      <div class="layer blackout ${timeline?.blackout ? "on" : ""}" part="blackout"></div>
    `;
  }

  protected override updated() {
    const root = this.renderRoot;
    this.#main ??= new SceneLayer(root.querySelector(".main") as HTMLElement);
    this.#interrupt ??= new SceneLayer(root.querySelector(".interrupt") as HTMLElement);
    const { state, ctx } = this;
    if (!state || !ctx) return;
    const { main, next, interrupt } = state.timeline;
    this.#main.update(state, ctx, main?.instanceId, next?.instanceId);
    this.#interrupt.update(state, ctx, interrupt?.instanceId);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
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
