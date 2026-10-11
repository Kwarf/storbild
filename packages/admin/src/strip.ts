import type { ShowState } from "@storbild/core";
import type { ViewerContext } from "@storbild/plugin-sdk/viewer";
import "@storbild/viewer";
import { css, html, LitElement, nothing, type PropertyDeclarations } from "lit";
import { formatClock, formatDuration } from "./format.ts";
import { instanceName, onAir, typeLabel } from "./status.ts";
import { controls } from "./styles.ts";

/**
 * The pinned now/next strip (DESIGN.md §8.2): a live preview, which is the viewer's own
 * compositor fed from the admin's state, what is on air with the time left, what comes next,
 * the active overlays, and whether the show runs on its own or is overridden.
 */
export class Strip extends LitElement {
  static override properties: PropertyDeclarations = {
    state: { attribute: false },
    ctx: { attribute: false },
    now: { state: true },
  };

  static override styles = [
    controls,
    css`
      :host {
        display: grid;
        grid-template-columns: 288px minmax(0, 1fr);
        gap: 20px;
        padding: 16px 24px;
        border-bottom: 1px solid var(--sb-line);
      }
      .preview {
        width: 288px;
        aspect-ratio: 16 / 9;
        background: #000;
        border: 1px solid var(--sb-line);
        border-radius: var(--sb-radius);
        overflow: hidden;
      }
      sb-stage {
        width: 100%;
        height: 100%;
      }
      .rows {
        display: grid;
        grid-template-columns: 88px minmax(0, 1fr) auto;
        align-content: start;
      }
      .rows > * {
        padding: 7px 0;
        border-bottom: 1px solid var(--sb-line);
        min-width: 0;
      }
      .rows > :nth-last-child(-n + 3) {
        border-bottom: 0;
      }
      .key {
        color: var(--sb-muted);
        font-size: var(--sb-text-xs);
        font-weight: var(--sb-weight-strong);
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding-top: 9px;
      }
      .value {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .value .type {
        color: var(--sb-muted);
        font-size: var(--sb-text-sm);
        margin-left: 8px;
      }
      .aside {
        text-align: right;
        padding-left: 16px;
        font-size: var(--sb-text-sm);
        color: var(--sb-muted);
      }
      .mode {
        grid-column: 1 / -1;
        display: flex;
        align-items: baseline;
        gap: 10px;
        padding: 2px 0 9px 10px;
        border-left: 3px solid var(--status);
      }
      .mode .title {
        font-size: var(--sb-text-lg);
        font-weight: var(--sb-weight-strong);
        color: var(--status);
      }
      .mode .detail {
        color: var(--sb-muted);
      }
      .rotation {
        --status: var(--sb-live);
      }
      .take,
      .interrupt,
      .blackout {
        --status: var(--sb-override);
      }
      .progress {
        height: 3px;
        margin-top: 6px;
        background: var(--sb-track);
        border-radius: 2px;
        overflow: hidden;
      }
      .progress > div {
        height: 100%;
        background: var(--sb-live);
        transition: width 1s linear;
      }
    `,
  ];

  declare state: ShowState | undefined;
  declare ctx: ViewerContext | undefined;
  declare now: number;
  #ticker: number | undefined;

  constructor() {
    super();
    this.now = Date.now();
  }

  override connectedCallback() {
    super.connectedCallback();
    // Clock text only; scheduling stays with the compositor's own timer.
    this.#ticker = window.setInterval(() => {
      if (document.visibilityState === "visible" && this.ctx) this.now = this.ctx.serverNow();
    }, 1000);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.clearInterval(this.#ticker);
  }

  protected override willUpdate() {
    if (this.ctx) this.now = this.ctx.serverNow();
  }

  override render() {
    const { state, ctx, now } = this;
    return html`
      <div class="preview" aria-label="Live preview">
        <sb-stage><sb-compositor .state=${state} .ctx=${ctx}></sb-compositor></sb-stage>
      </div>
      ${state ? this.#rows(state, now) : html`<div class="muted">Connecting…</div>`}
    `;
  }

  #rows(state: ShowState, now: number) {
    const status = onAir(state, now);
    const { main, next, interrupt } = status.timeline;
    const overlays = state.overlays.filter((overlay) => overlay.visible);
    return html`<div class="rows">
      <div class="mode ${status.mode}" data-mode=${status.mode}>
        <span class="title">${status.title}</span>
        <span class="detail num">${status.detail}</span>
      </div>

      <div class="key">Now</div>
      <div class="value" data-row="now">
        ${main ? this.#name(state, main.instanceId) : html`<span class="muted">Background only</span>`}
        ${
          // Under an interrupt the scene is frozen, so its progress means nothing.
          main?.endsAt !== undefined && !interrupt
            ? this.#progress(main.startedAt, main.endsAt, now)
            : nothing
        }
      </div>
      <div class="aside num">
        ${
          main === undefined
            ? nothing
            : interrupt
              ? "paused"
              : main.endsAt === undefined
                ? "holds"
                : `${formatDuration(main.endsAt - now)} left`
        }
      </div>

      <div class="key">Next</div>
      <div class="value" data-row="next">
        ${next ? this.#name(state, next.instanceId) : html`<span class="muted">Nothing scheduled</span>`}
      </div>
      <div class="aside num">
        ${next ? html`in ${formatDuration(next.startsAt - now)} · ${formatClock(next.startsAt)}` : nothing}
      </div>

      <div class="key">Overlays</div>
      <div class="value">
        ${
          overlays.length > 0
            ? overlays.map((overlay) => instanceName(state, overlay.instanceId)).join(", ")
            : html`<span class="muted">None</span>`
        }
      </div>
      <div class="aside"></div>
    </div>`;
  }

  #name(state: ShowState, instanceId: string) {
    const label = typeLabel(state, instanceId);
    return html`<span class="name">${instanceName(state, instanceId)}</span>${
      label ? html`<span class="type">${label}</span>` : nothing
    }`;
  }

  #progress(startedAt: number, endsAt: number, now: number) {
    const fraction = Math.min(1, Math.max(0, (now - startedAt) / (endsAt - startedAt)));
    return html`<div class="progress">
      <div style="width: ${(fraction * 100).toFixed(2)}%"></div>
    </div>`;
  }
}

customElements.define("sb-strip", Strip);
