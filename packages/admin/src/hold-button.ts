import { css, html, LitElement, type PropertyDeclarations } from "lit";
import { controls } from "./styles.ts";

/**
 * A button that acts only after being held for `holdMs`, with pointer or Space/Enter, for
 * controls a stray click must not trigger (DESIGN.md §8.2). A fill shows the progress; letting
 * go early cancels. Fires `activate` when the hold completes.
 */
export class HoldButton extends LitElement {
  static override properties: PropertyDeclarations = {
    holdMs: { type: Number, attribute: "hold-ms" },
    disabled: { type: Boolean },
    holding: { state: true },
  };

  static override styles = [
    controls,
    css`
      :host {
        display: inline-block;
      }
      button {
        position: relative;
        overflow: hidden;
        user-select: none;
        touch-action: none;
      }
      .fill {
        position: absolute;
        inset: 0;
        background: var(--sb-text);
        opacity: 0.16;
        transform: scaleX(0);
        transform-origin: left;
        pointer-events: none;
      }
      .holding .fill {
        transform: scaleX(1);
        transition: transform var(--hold-ms) linear;
      }
      .label {
        position: relative;
      }
    `,
  ];

  declare holdMs: number;
  declare disabled: boolean;
  declare holding: boolean;
  #timer: number | undefined;

  constructor() {
    super();
    this.holdMs = 1500;
    this.disabled = false;
    this.holding = false;
  }

  override render() {
    return html`<button
      class=${this.holding ? "holding" : ""}
      style="--hold-ms: ${this.holdMs}ms"
      ?disabled=${this.disabled}
      @pointerdown=${this.#start}
      @pointerup=${this.#cancel}
      @pointerleave=${this.#cancel}
      @pointercancel=${this.#cancel}
      @keydown=${(event: KeyboardEvent) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
          event.preventDefault();
          this.#start();
        }
      }}
      @keyup=${(event: KeyboardEvent) => {
        if (event.key === " " || event.key === "Enter") this.#cancel();
      }}
      @blur=${this.#cancel}
      @click=${(event: Event) => event.preventDefault()}
    >
      <span class="fill"></span><span class="label"><slot></slot></span>
    </button>`;
  }

  #start = () => {
    if (this.disabled || this.holding) return;
    this.holding = true;
    this.#timer = window.setTimeout(() => {
      this.holding = false;
      this.dispatchEvent(new Event("activate", { bubbles: true, composed: true }));
    }, this.holdMs);
  };

  #cancel = () => {
    window.clearTimeout(this.#timer);
    this.holding = false;
  };

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#cancel();
  }
}

customElements.define("sb-hold-button", HoldButton);
