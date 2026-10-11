import {
  type Command,
  type Instance,
  type InterruptBelow,
  isPlayableScene,
  type ShowState,
} from "@storbild/core";
import type { ViewerContext } from "@storbild/plugin-sdk/viewer";
import { css, html, LitElement, nothing, type PropertyDeclarations } from "lit";
import { send } from "./api.ts";
import { parseDuration } from "./format.ts";
import "./hold-button.ts";
import { onAir } from "./status.ts";
import { controls } from "./styles.ts";

type Action = "announce" | "take" | "blackout";

/** The plugin and type that quick announce creates (ADR 0011). */
const QUICK = { plugin: "announcement", type: "announcement" } as const;

/** An instance name from a typed message: its first line, shortened. */
export function messageName(message: string): string {
  const line = message.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 40 ? `${line.slice(0, 39).trimEnd()}…` : line || "Announcement";
}

/** What the screen shows beneath an announcement (ADR 0008). */
const belowOptions: [InterruptBelow, string][] = [
  ["hide", "Cover the screen"],
  ["dim", "Dim the screen"],
  ["show", "Over the screen"],
];

/**
 * The Live panel (DESIGN.md §8.2): announce (an interrupt), take now, resume and blackout.
 * Quick announce turns a typed message into an `announcement` instance and interrupts with it;
 * the instance stays in the library, so it can be announced again (ADR 0011).
 */
export class LivePanel extends LitElement {
  static override properties: PropertyDeclarations = {
    state: { attribute: false },
    ctx: { attribute: false },
    errors: { state: true },
    busy: { state: true },
    announce: { state: true },
    message: { state: true },
    kind: { state: true },
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
      textarea {
        box-sizing: border-box;
        width: 100%;
        max-width: 560px;
        resize: vertical;
        line-height: 1.4;
      }
      .switch {
        display: inline-flex;
        margin-bottom: 10px;
      }
      .switch button {
        border-radius: 0;
        font-weight: var(--sb-weight);
      }
      .switch button:first-child {
        border-radius: var(--sb-radius) 0 0 var(--sb-radius);
      }
      .switch button:last-child {
        border-radius: 0 var(--sb-radius) var(--sb-radius) 0;
        margin-left: -1px;
      }
      .switch button[aria-pressed="true"] {
        position: relative;
        background: var(--sb-bg-sunken);
        border-color: var(--sb-text);
        font-weight: var(--sb-weight-strong);
      }
      select.below {
        flex: 0 0 auto;
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
  declare announce: { instanceId: string; duration: string; below: InterruptBelow };
  /** The quick announce message being typed. */
  declare message: string;
  /** Whether a typed message or an existing instance is announced. */
  declare kind: "message" | "instance";
  declare takeId: string;
  #takeDuration = "";
  #ticker: number | undefined;

  constructor() {
    super();
    this.errors = {};
    this.busy = undefined;
    this.announce = { instanceId: "", duration: "", below: "hide" };
    this.message = "";
    this.kind = "message";
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
    // Typed messages need the announcement plugin; without it, only instances can be announced.
    const quick = state.plugins[QUICK.plugin]?.status === "ok";
    const kind = quick ? this.kind : "instance";
    return html`
      <h1>Live</h1>

      <section data-section="announce">
        <h2>Announce</h2>
        <p class="hint">
          Shows a message or an instance above everything else until it ends or is dismissed.
        </p>
        ${
          quick
            ? html`<div class="switch" role="group" aria-label="Announce what">
                ${(["message", "instance"] as const).map(
                  (kind) => html`<button
                    aria-pressed=${kind === this.kind ? "true" : "false"}
                    @click=${() => {
                      this.kind = kind;
                    }}
                  >
                    ${kind === "message" ? "Message" : "Instance"}
                  </button>`,
                )}
              </div>`
            : nothing
        }
        <div class="row">
          ${
            kind === "message"
              ? html`<textarea
                  rows="3"
                  aria-label="Message"
                  placeholder="Type a message. Ctrl+Enter announces it."
                  .value=${this.message}
                  @input=${(event: Event) => {
                    this.message = (event.target as HTMLTextAreaElement).value;
                  }}
                  @keydown=${(event: KeyboardEvent) => {
                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey))
                      void this.#announce();
                  }}
                ></textarea>`
              : this.#picker("Announcement", this.announce.instanceId, (instanceId) => {
                  this.announce = { ...this.announce, instanceId };
                })
          }
        </div>
        <div class="row">
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
          <select
            class="below"
            aria-label="Beneath the announcement"
            @change=${(event: Event) => {
              const below = (event.target as HTMLSelectElement).value as InterruptBelow;
              this.announce = { ...this.announce, below };
            }}
          >
            ${belowOptions.map(
              ([value, label]) =>
                html`<option value=${value} ?selected=${value === this.announce.below}>${label}</option>`,
            )}
          </select>
          <button
            class="primary"
            ?disabled=${this.busy === "announce" || (kind === "message" ? this.message.trim() === "" : !this.announce.instanceId)}
            @click=${this.#announce}
          >
            Announce
          </button>
        </div>
        ${this.#error("announce")}
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
      </section>

      <section data-section="take">
        <h2>Take now</h2>
        <p class="hint">Replaces the scene on air. The rotation continues with the next item afterwards.</p>
        <div class="row">
          ${this.#picker("Scene to take", this.takeId, (instanceId) => {
            this.takeId = instanceId;
          })}
        </div>
        <div class="row">
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
    const option = (instance: Instance) => {
      const playable = isPlayableScene(state, instance.id);
      return html`<option value=${instance.id} ?selected=${value === instance.id} ?disabled=${!playable}>
        ${instance.name}${playable ? "" : " (broken)"}
      </option>`;
    };
    // Announcements, typed ones included, come first: they are what is announced most.
    const isQuick = (instance: Instance) =>
      instance.plugin === QUICK.plugin && instance.type === QUICK.type;
    const announcements = scenes.filter(isQuick);
    const others = scenes.filter((instance) => !isQuick(instance));
    return html`<select
      aria-label=${label}
      @change=${(event: Event) => onPick((event.target as HTMLSelectElement).value)}
    >
      <option value="" ?selected=${value === ""}>Choose an instance…</option>
      ${
        announcements.length > 0
          ? html`<optgroup label="Announcements">${announcements.map(option)}</optgroup>
              <optgroup label="Other scenes">${others.map(option)}</optgroup>`
          : others.map(option)
      }
    </select>`;
  }

  #name(instanceId: string) {
    return this.state?.instances[instanceId]?.name ?? "Deleted instance";
  }

  #error(action: Action) {
    const error = this.errors[action];
    return error ? html`<p class="error" role="alert">${error}</p>` : nothing;
  }

  /**
   * The shared duration in ms: undefined to hold until dismissed, or null after showing an
   * error next to `action` when it can't be read.
   */
  #duration(action: Action): number | undefined | null {
    const durationMs = parseDuration(this.announce.duration);
    if (durationMs === null) {
      this.errors = {
        ...this.errors,
        [action]: "Enter a duration as seconds or m:ss, or leave it blank.",
      };
    }
    return durationMs;
  }

  #interrupt(instanceId: string, durationMs: number | undefined): Command {
    return {
      type: "live.interrupt",
      payload: {
        instanceId,
        below: this.announce.below,
        ...(durationMs !== undefined && { durationMs }),
      },
    };
  }

  /** Interrupts with the chosen instance, or with a new announcement of the typed message. */
  #announce = async () => {
    const quick = this.state?.plugins[QUICK.plugin]?.status === "ok";
    const kind = quick ? this.kind : "instance";
    const message = this.message.trim();
    if (this.busy === "announce") return;
    if (kind === "message" ? message === "" : !this.announce.instanceId) return;
    const durationMs = this.#duration("announce");
    if (durationMs === null) return;
    if (kind === "instance") {
      void this.#run("announce", this.#interrupt(this.announce.instanceId, durationMs));
      return;
    }
    const ok = await this.#run("announce", async () => {
      const { id } = await send({
        type: "instance.create",
        payload: { ...QUICK, name: messageName(message), config: { message } },
      });
      if (id) await send(this.#interrupt(id, durationMs));
    });
    if (ok) this.message = "";
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

  /** Sends a command, or runs several steps, showing a refusal next to the control. */
  async #run(action: Action, work: Command | (() => Promise<void>)): Promise<boolean> {
    this.busy = action;
    this.errors = { ...this.errors, [action]: undefined };
    try {
      if (typeof work === "function") await work();
      else await send(work);
      return true;
    } catch (error) {
      this.errors = {
        ...this.errors,
        [action]: error instanceof Error ? error.message : String(error),
      };
      return false;
    } finally {
      this.busy = undefined;
    }
  }
}

customElements.define("sb-live-panel", LivePanel);
