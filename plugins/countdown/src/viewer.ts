import type { PluginConfig } from "@storbild/plugin-sdk";
import { StorbildOverlay, StorbildScene } from "@storbild/plugin-sdk/viewer";
import { css, html, type ReactiveElement } from "lit";
import { formatRemaining, remaining, untilNextTick } from "./countdown.ts";
import type plugin from "./plugin.ts";

type SceneConfig = PluginConfig<typeof plugin, "countdown">;
type WidgetConfig = PluginConfig<typeof plugin, "widget">;

/** Redraws an element each time the shown time changes, until the target. */
class Ticker {
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly element: ReactiveElement) {}

  arm(target: number, now: number) {
    this.stop();
    const wait = untilNextTick(target, now);
    if (wait !== undefined && this.element.isConnected) {
      this.#timer = setTimeout(() => this.element.requestUpdate(), wait + 5);
    }
  }

  stop() {
    clearTimeout(this.#timer);
  }
}

/** The text to show: the time left, or the done text once the target has passed. */
function shown(target: number, now: number, doneText: string | undefined) {
  const left = remaining(target, now);
  const done = left === 0;
  return { done, text: done && doneText ? doneText : formatRemaining(left) };
}

const numbers = css`
  .time {
    font-family: var(--sb-font-heading, sans-serif);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    white-space: nowrap;
  }
  .time.done {
    white-space: normal;
    overflow-wrap: anywhere;
  }
`;

/** A full-screen countdown with an optional title. */
export class CountdownScene extends StorbildScene<SceneConfig> {
  static override styles = [
    numbers,
    css`
      :host {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.4em;
        box-sizing: border-box;
        height: 100%;
        padding: var(--sb-safe-area, 96px);
        color: var(--sb-color-text, #fff);
        font-family: var(--sb-font-body, sans-serif);
        text-align: center;
      }
      h1 {
        margin: 0;
        font-family: var(--sb-font-heading, sans-serif);
        font-size: 72px;
        color: var(--sb-color-accent, #e8a33d);
      }
      .time {
        font-size: 240px;
      }
      .time.done {
        font-size: 160px;
      }
    `,
  ];

  #ticker = new Ticker(this);

  override render() {
    const { title, target, doneText } = this.config;
    const now = this.ctx.serverNow();
    this.#ticker.arm(target, now);
    const { done, text } = shown(target, now, doneText);
    return html`${title ? html`<h1>${title}</h1>` : null}
      <div class="time ${done ? "done" : ""}">${text}</div>`;
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) this.requestUpdate();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#ticker.stop();
  }
}

/** A compact countdown widget, hidden `hideAfterMs` after its target. */
export class CountdownWidget extends StorbildOverlay<WidgetConfig> {
  static override styles = [
    numbers,
    css`
      :host {
        display: block;
        padding: 12px 28px;
        border-radius: 8px;
        background: var(--sb-color-surface, #15171c);
        color: var(--sb-color-text, #fff);
        font-family: var(--sb-font-body, sans-serif);
      }
      .label {
        font-size: 24px;
        color: var(--sb-color-muted, #9aa0aa);
      }
      .time {
        font-size: 56px;
        line-height: 1.1;
      }
    `,
  ];

  #ticker = new Ticker(this);

  override staleAt() {
    return this.config.target + this.config.hideAfterMs;
  }

  override render() {
    const { label, target, doneText } = this.config;
    const now = this.ctx.serverNow();
    this.#ticker.arm(target, now);
    const { done, text } = shown(target, now, doneText);
    return html`${label ? html`<div class="label">${label}</div>` : null}
      <div class="time ${done ? "done" : ""}">${text}</div>`;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#ticker.stop();
  }
}

customElements.define("sb-countdown-scene", CountdownScene);
customElements.define("sb-countdown-widget", CountdownWidget);
