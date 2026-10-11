import { css, html, LitElement } from "lit";

export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;

/**
 * Fills its container with a fixed 1920×1080 canvas, scaled uniformly to fit and centred, so
 * mirrors in odd-sized windows look identical (DESIGN.md §7). The rest is letterboxed in black.
 */
export class Stage extends LitElement {
  static override styles = css`
    :host {
      position: relative;
      display: block;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #000;
    }
    .canvas {
      position: absolute;
      left: 50%;
      top: 50%;
      width: ${STAGE_WIDTH}px;
      height: ${STAGE_HEIGHT}px;
      transform-origin: center;
    }
  `;

  readonly #observer = new ResizeObserver(() => this.#fit());

  override connectedCallback() {
    super.connectedCallback();
    this.#observer.observe(this);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#observer.disconnect();
  }

  override render() {
    return html`<div class="canvas" part="canvas"><slot></slot></div>`;
  }

  protected override firstUpdated() {
    this.#fit();
  }

  #fit() {
    const canvas = this.renderRoot.querySelector<HTMLElement>(".canvas");
    if (!canvas) return;
    const scale = Math.min(this.clientWidth / STAGE_WIDTH, this.clientHeight / STAGE_HEIGHT);
    canvas.style.transform = `translate(-50%, -50%) scale(${scale})`;
  }
}

customElements.define("sb-stage", Stage);
