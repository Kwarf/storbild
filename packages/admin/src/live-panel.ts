import { type Command, isPlayableScene, type ShowState } from "@storbild/core";
import type { ViewerContext } from "@storbild/plugin-sdk/viewer";
import { css, html, LitElement, nothing, type PropertyDeclarations } from "lit";
import { send } from "./api.ts";
import { parseDuration } from "./format.ts";
import "./hold-button.ts";
import { onAir } from "./status.ts";
import { controls } from "./styles.ts";

type Action = "announce" | "take" | "blackout";

/**
 * The Live panel (DESIGN.md §8.2): announce (an interrupt), take now, resume and blackout.
 * Quick announce with a typed message arrives with the announcement plugin (M6).
 */
export class LivePanel extends LitElement {
  static override properties: PropertyDeclarations = {
    state: { attribute: false },
    ctx: { attribute: false },
    errors: { state: true },
    busy: { state: true },
    announce: { state: true },
    takeId: { state: true },
  };

  static override styles = [
    controls,
    css`
      :host {
        display: block;
        padding: 20px 24px 40px;
        max-width: 880px;
      }
      h1 {
        font-size: var(--sb-text-xl);
        font-weight: var(--sb-weight-strong);
        margin: 0 0 8px;
        letter-spacing: -0.01em;
      }
      section {
        padding: 16px 0;
        border-bottom: 1px solid var(--sb-line);
      }
      h2 {
        font-size: var(--sb-text-lg);
        font-weight: var(--sb-weight-strong);
        margin: 0;
      }
      .hint {
        color: var(--sb-muted);
        font-size: var(--sb-text-sm);
        margin: 2px 0 12px;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
      }
      .row + .row {
        margin-top: 10px;
      }
      select {
        flex: 1 1 240px;
        max-width: 360px;
      }
      input[type="text"] {
        width: 128px;
      }
      label.check {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: var(--sb-text-sm);
      }
      .active {
        padding: 8px 10px;
        border-left: 3px solid var(--sb-override);
        background: var(--sb-bg-sunken);
      }
      .active .what {
        flex: 1;
      }
      .active strong {
        font-weight: var(--sb-weight-strong);
      }
      .error {
        margin: 8px 0 0;
      }
    `,
  ];

  declare state: ShowState | undefined;
  declare ctx: ViewerContext | undefined;
  declare errors: Partial<Record<Action, string>>;
  declare busy: Action | undefined;
  declare announce: { instanceId: string; duration: string; dim: boolean };
  declare takeId: string;
  #takeDuration = "";
  #ticker: number | undefined;

  constructor() {
    super();
    this.errors = {};
    this.busy = undefined;
    this.announce = { instanceId: "", duration: "", dim: true };
    this.takeId = "";
  }

  override connectedCallback() {
    super.connectedCallback();
    // Keeps the "returns in" countdowns current.
    this.#ticker = window.setInterval(() => {
      if (document.visibilityState === "visible") this.requestUpdate();
    }, 1000);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.clearInterval(this.#ticker);
  }

  override render() {
    const { state, ctx } = this;
    if (!state || !ctx) return html`<h1>Live</h1><p class="muted">Connecting…</p>`;
    const status = onAir(state, ctx.serverNow());
    const override = status.timeline.mode === "override";
    return html`
      <h1>Live</h1>

      <section data-section="announce">
        <h2>Announce</h2>
        <p class="hint">Shows an instance above everything else until it ends or is dismissed.</p>
        <div class="row">
          ${this.#picker("Announcement", this.announce.instanceId, (instanceId) => {
            this.announce = { ...this.announce, instanceId };
          })}
          <input
            type="text"
            class="num"
            aria-label="Announcement duration"
            placeholder="Until dismissed"
            .value=${this.announce.duration}
            @input=${(event: Event) => {
              this.announce = {
                ...this.announce,
                duration: (event.target as HTMLInputElement).value,
              };
            }}
          />
          <label class="check">
            <input
              type="checkbox"
              .checked=${this.announce.dim}
              @change=${(event: Event) => {
                this.announce = {
                  ...this.announce,
                  dim: (event.target as HTMLInputElement).checked,
                };
              }}
            />
            Dim below
          </label>
          <button
            class="primary"
            ?disabled=${!this.announce.instanceId || this.busy === "announce"}
            @click=${this.#announce}
          >
            Interrupt
          </button>
        </div>
        ${
          status.mode === "interrupt" || status.timeline.interrupt
            ? html`<div class="row active">
                <span class="what"
                  ><strong>${status.timeline.interrupt && this.#name(status.timeline.interrupt.instanceId)}</strong>
                  <span class="muted num">${status.mode === "interrupt" ? status.detail : "on air"}</span></span
                >
                <button @click=${() => this.#run("announce", { type: "live.clearInterrupt", payload: {} })}>
                  Dismiss
                </button>
              </div>`
            : nothing
        }
        ${this.#error("announce")}
      </section>

      <section data-section="take">
        <h2>Take now</h2>
        <p class="hint">Replaces the scene on air. The rotation continues with the next item afterwards.</p>
        <div class="row">
          ${this.#picker("Scene to take", this.takeId, (instanceId) => {
            this.takeId = instanceId;
          })}
          <input
            type="text"
            class="num"
            aria-label="Take duration"
            placeholder="Until resumed"
            @input=${(event: Event) => {
              this.#takeDuration = (event.target as HTMLInputElement).value;
            }}
          />
          <button class="primary" ?disabled=${!this.takeId || this.busy === "take"} @click=${this.#take}>
            Take now
          </button>
        </div>
        ${
          override
            ? html`<div class="row active">
                <span class="what"
                  ><strong>${status.mode === "take" ? status.title : "Rotation paused"}</strong>
                  <span class="muted num">${status.mode === "take" ? status.detail : "by an interrupt"}</span></span
                >
                <button @click=${() => this.#run("take", { type: "live.resume", payload: {} })}>
                  Resume rotation
                </button>
              </div>`
            : nothing
        }
        ${this.#error("take")}
      </section>

      <section data-section="blackout">
        <h2>Blackout</h2>
        <p class="hint">Turns every screen black. The show keeps running underneath.</p>
        <div class="row">
          ${
            state.live.blackout
              ? html`<div class="row active" style="flex: 1">
                  <span class="what"><strong>Blackout is on</strong></span>
                  <button @click=${() => this.#run("blackout", { type: "live.blackout", payload: { on: false } })}>
                    End blackout
                  </button>
                </div>`
              : html`<sb-hold-button
                    hold-ms="1500"
                    ?disabled=${this.busy === "blackout"}
                    @activate=${() => this.#run("blackout", { type: "live.blackout", payload: { on: true } })}
                    >Hold to black out</sb-hold-button
                  >
                  <span class="muted" style="font-size: var(--sb-text-sm)">Hold for 1.5 seconds</span>`
          }
        </div>
        ${this.#error("blackout")}
      </section>
    `;
  }

  /** Scene instances by name. Broken ones are listed but can't be picked. */
  #picker(label: string, value: string, onPick: (instanceId: string) => void) {
    const state = this.state as ShowState;
    const scenes = Object.values(state.instances)
      .filter(
        (instance) => state.plugins[instance.plugin]?.types[instance.type]?.kind !== "overlay",
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    return html`<select
      aria-label=${label}
      @change=${(event: Event) => onPick((event.target as HTMLSelectElement).value)}
    >
      <option value="" ?selected=${value === ""}>Choose an instance…</option>
      ${scenes.map((instance) => {
        const playable = isPlayableScene(state, instance.id);
        return html`<option value=${instance.id} ?selected=${value === instance.id} ?disabled=${!playable}>
          ${instance.name}${playable ? "" : " (broken)"}
        </option>`;
      })}
    </select>`;
  }

  #name(instanceId: string) {
    return this.state?.instances[instanceId]?.name ?? "Deleted instance";
  }

  #error(action: Action) {
    const error = this.errors[action];
    return error ? html`<p class="error" role="alert">${error}</p>` : nothing;
  }

  #announce = () => {
    const durationMs = parseDuration(this.announce.duration);
    if (durationMs === null) {
      this.errors = {
        ...this.errors,
        announce: "Enter a duration as seconds or m:ss, or leave it blank.",
      };
      return;
    }
    void this.#run("announce", {
      type: "live.interrupt",
      payload: {
        instanceId: this.announce.instanceId,
        dimBelow: this.announce.dim,
        ...(durationMs !== undefined && { durationMs }),
      },
    });
  };

  #take = () => {
    const durationMs = parseDuration(this.#takeDuration);
    if (durationMs === null) {
      this.errors = {
        ...this.errors,
        take: "Enter a duration as seconds or m:ss, or leave it blank.",
      };
      return;
    }
    void this.#run("take", {
      type: "live.take",
      payload: { instanceId: this.takeId, ...(durationMs !== undefined && { durationMs }) },
    });
  };

  async #run(action: Action, command: Command) {
    this.busy = action;
    this.errors = { ...this.errors, [action]: undefined };
    try {
      await send(command);
    } catch (error) {
      this.errors = {
        ...this.errors,
        [action]: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.busy = undefined;
    }
  }
}

customElements.define("sb-live-panel", LivePanel);
