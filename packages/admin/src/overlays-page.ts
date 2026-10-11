import {
  type Command,
  type OverlayPlacement,
  type OverlaySlot,
  reservedSlots,
  resolveTimeline,
  type ShowState,
  slotStack,
} from "@storbild/core";
import type { ViewerContext } from "@storbild/plugin-sdk/viewer";
import { css, html, LitElement, nothing, type PropertyDeclarations } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { errorText, send } from "./api.ts";
import { instanceName, typeLabel } from "./status.ts";
import { controls, page } from "./styles.ts";

export const slotLabels: Record<OverlaySlot, string> = {
  "top-bar": "Top bar",
  "top-left": "Top left",
  top: "Top",
  "top-right": "Top right",
  left: "Left",
  right: "Right",
  "bottom-left": "Bottom left",
  bottom: "Bottom",
  "bottom-right": "Bottom right",
  "bottom-bar": "Bottom bar",
};

/** The slots from top to bottom, left to right, as the diagram and the list show them. */
const slots = Object.keys(slotLabels) as OverlaySlot[];

/** Where a dragged widget would land: before the widget at `index` in `slot`. */
interface DropAt {
  slot: OverlaySlot;
  index: number;
}

/**
 * The Overlays page (DESIGN.md §8.2, ADR 0012): a diagram of the screen's slots, and the
 * placed widgets as rows grouped by slot, with drag-to-reorder within and across slots, a
 * visibility toggle and removal. Every edit is a command; the rows follow the state.
 */
export class OverlaysPage extends LitElement {
  static override properties: PropertyDeclarations = {
    state: { attribute: false },
    ctx: { attribute: false },
    errors: { state: true },
    target: { state: true },
    addId: { state: true },
    dragging: { state: true },
    dropAt: { state: true },
  };

  static override styles = [
    controls,
    page,
    css`
      :host {
        max-width: 1120px;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(280px, 400px) minmax(0, 1fr);
        gap: 24px;
        align-items: start;
        margin-top: 16px;
      }
      @media (max-width: 900px) {
        .layout {
          grid-template-columns: minmax(0, 1fr);
        }
      }

      .diagram {
        /* Roughly the screen's shape, growing when a slot lists many widgets. */
        min-height: 232px;
        box-sizing: border-box;
        padding: 6px;
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
        grid-template-rows: auto minmax(52px, auto) minmax(52px, 1fr) minmax(52px, auto) auto;
        grid-template-areas:
          "top-bar top-bar top-bar"
          "top-left top top-right"
          "left centre right"
          "bottom-left bottom bottom-right"
          "bottom-bar bottom-bar bottom-bar";
        gap: 4px;
        border: 1px solid var(--sb-line-strong);
        border-radius: var(--sb-radius);
        background: var(--sb-bg-sunken);
      }
      .diagram .centre {
        grid-area: centre;
        display: grid;
        place-items: center;
        color: var(--sb-muted);
        font-size: var(--sb-text-xs);
      }
      .cell {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        justify-content: flex-start;
        gap: 2px;
        min-width: 0;
        min-height: 22px;
        padding: 3px 5px;
        font-weight: var(--sb-weight);
        font-size: var(--sb-text-xs);
        text-align: left;
      }
      .cell .label {
        color: var(--sb-muted);
        font-weight: var(--sb-weight-strong);
      }
      .cell .widget {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cell .widget.off {
        color: var(--sb-muted);
        text-decoration: line-through;
      }
      .cell[aria-pressed="true"] {
        outline: 2px solid var(--sb-accent);
        outline-offset: -2px;
      }
      .cell.reserved {
        border-style: dashed;
      }
      .cell.drop {
        border-color: var(--sb-accent);
      }
      .legend {
        margin: 8px 0 0;
        color: var(--sb-muted);
        font-size: var(--sb-text-sm);
      }

      .group + .group {
        margin-top: 16px;
      }
      .group h2 {
        display: flex;
        align-items: baseline;
        gap: 8px;
        font-size: var(--sb-text-md);
        padding-bottom: 4px;
      }
      .group h2 .sub {
        color: var(--sb-muted);
        font-size: var(--sb-text-sm);
        font-weight: var(--sb-weight);
      }
      ol {
        list-style: none;
        margin: 0;
        padding: 0;
        border-top: 1px solid var(--sb-line);
      }
      ol.drop-end {
        border-bottom: 2px solid var(--sb-accent);
      }
      li {
        position: relative;
        border-bottom: 1px solid var(--sb-line);
      }
      li.dragging {
        opacity: 0.4;
      }
      li.drop-before::before {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        top: -1px;
        height: 2px;
        background: var(--sb-accent);
      }
      .row {
        display: grid;
        grid-template-columns: 20px 24px minmax(0, 1fr) 140px auto;
        align-items: center;
        gap: 10px;
        padding: 6px 0;
      }
      li.off .what {
        color: var(--sb-muted);
      }
      .handle {
        cursor: grab;
        color: var(--sb-muted);
        text-align: center;
        user-select: none;
        letter-spacing: -2px;
      }
      .what {
        min-width: 0;
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 4px 10px;
      }
      .what .name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .what .sub {
        color: var(--sb-muted);
        font-size: var(--sb-text-sm);
      }
      .row .actions {
        gap: 4px;
        justify-content: flex-end;
      }
      .row .actions button {
        padding: 4px 8px;
      }
      li > .error {
        margin: 0 0 8px 54px;
      }
      .empty {
        padding: 16px 0;
        color: var(--sb-muted);
        border-top: 1px solid var(--sb-line);
        border-bottom: 1px solid var(--sb-line);
        margin: 0;
      }
      .add {
        margin-top: 20px;
      }
      .add select {
        flex: 1 1 200px;
        max-width: 300px;
      }
    `,
  ];

  declare state: ShowState | undefined;
  declare ctx: ViewerContext | undefined;
  /** Errors by instance ID, or `add`. */
  declare errors: Record<string, string>;
  /** The slot new widgets are placed in; chosen in the diagram or the add bar. */
  declare target: OverlaySlot;
  declare addId: string;
  /** The instance ID of the widget being dragged. */
  declare dragging: string | undefined;
  declare dropAt: DropAt | undefined;
  #ticker: number | undefined;

  constructor() {
    super();
    this.errors = {};
    this.target = "bottom-right";
    this.addId = "";
  }

  override connectedCallback() {
    super.connectedCallback();
    // Keeps the reserved slots current as scenes change.
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
    if (!state || !ctx) return html`<h1>Overlays</h1><p class="muted">Connecting…</p>`;
    const reserved = reservedSlots(state, resolveTimeline(state, ctx.serverNow()));
    const placed = new Set(state.overlays.map((p) => p.instanceId));
    const unplaced = Object.values(state.instances)
      .filter(
        (instance) =>
          !placed.has(instance.id) &&
          state.plugins[instance.plugin]?.types[instance.type]?.kind === "overlay",
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    const used = slots.filter((slot) => state.overlays.some((p) => p.slot === slot));
    return html`
      <h1>Overlays</h1>
      <p class="hint">
        Widgets sit in fixed slots around the edge of the screen and stack toward the centre.
        A scene can reserve slots; their widgets fade out while it is on air.
      </p>
      <div class="layout">
        <div>
          ${this.#diagram(state, reserved)}
          <p class="legend">Dashed: reserved by what is on air now. Select a slot to place into it.</p>
        </div>
        <div>
          ${
            used.length === 0
              ? html`<p class="empty">No widgets are placed. Place one below.</p>`
              : used.map((slot) => this.#group(state, slot, reserved))
          }
          <div class="actions add">
            <select
              aria-label="Widget to place"
              @change=${(e: Event) => {
                this.addId = (e.target as HTMLSelectElement).value;
              }}
            >
              <option value="" ?selected=${this.addId === ""}>Choose a widget…</option>
              ${unplaced.map(
                (instance) =>
                  html`<option value=${instance.id} ?selected=${this.addId === instance.id}>${instance.name}</option>`,
              )}
            </select>
            ${this.#slotSelect("Slot to place in", this.target, (slot) => {
              this.target = slot;
            })}
            <button class="primary" ?disabled=${!this.addId} @click=${this.#place}>Place</button>
            ${
              unplaced.length === 0
                ? html`<span class="muted" style="font-size: var(--sb-text-sm)"
                    >${placed.size > 0 ? "Every widget is placed." : "Create overlay widgets in the Library first."}</span
                  >`
                : nothing
            }
          </div>
          ${this.errors.add ? html`<p class="error" role="alert">${this.errors.add}</p>` : nothing}
        </div>
      </div>
    `;
  }

  #diagram(state: ShowState, reserved: ReadonlySet<OverlaySlot>) {
    return html`<div class="diagram" aria-label="Slots">
      ${slots.map((slot) => {
        const stack = slotStack(state, slot);
        const drop = this.dragging !== undefined && this.dropAt?.slot === slot;
        return html`<button
          class="cell ${reserved.has(slot) ? "reserved" : ""} ${drop ? "drop" : ""}"
          style="grid-area: ${slot}"
          data-slot=${slot}
          aria-pressed=${this.target === slot ? "true" : "false"}
          title=${reserved.has(slot) ? `${slotLabels[slot]}: reserved now` : slotLabels[slot]}
          @click=${() => {
            this.target = slot;
          }}
          @dragover=${(e: DragEvent) => this.#over(e, { slot, index: stack.length })}
          @drop=${this.#drop}
        >
          <span class="label">${slotLabels[slot]}</span>
          ${stack.map(
            (p) =>
              html`<span class="widget ${p.visible ? "" : "off"}">${instanceName(state, p.instanceId)}</span>`,
          )}
        </button>`;
      })}
      <div class="centre">Scenes</div>
    </div>`;
  }

  #group(state: ShowState, slot: OverlaySlot, reserved: ReadonlySet<OverlaySlot>) {
    const stack = slotStack(state, slot);
    const endDrop =
      this.dragging !== undefined &&
      this.dropAt?.slot === slot &&
      this.dropAt.index === stack.length;
    return html`<section class="group" data-group=${slot}>
      <h2>
        ${slotLabels[slot]}
        ${reserved.has(slot) ? html`<span class="badge scheduled">Reserved now</span>` : nothing}
      </h2>
      <ol
        class=${endDrop ? "drop-end" : ""}
        @dragover=${(e: DragEvent) => {
          // Below the last row: the end of the stack.
          if ((e.target as HTMLElement).closest("li")) return;
          this.#over(e, { slot, index: stack.length });
        }}
        @drop=${this.#drop}
      >
        ${repeat(
          stack,
          (p) => p.instanceId,
          (p, i) => this.#row(state, p, i, stack.length),
        )}
      </ol>
    </section>`;
  }

  #row(state: ShowState, placement: OverlayPlacement, i: number, count: number) {
    const { instanceId, slot, visible } = placement;
    const instance = state.instances[instanceId];
    const label = typeLabel(state, instanceId);
    const broken = !instance || instance.error !== undefined || label === undefined;
    const drop =
      this.dragging !== undefined &&
      this.dragging !== instanceId &&
      this.dropAt?.slot === slot &&
      this.dropAt.index === i;
    return html`<li
      class="${visible ? "" : "off"} ${this.dragging === instanceId ? "dragging" : ""} ${drop ? "drop-before" : ""}"
      data-widget=${instanceId}
      @dragover=${(e: DragEvent) => {
        const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
        this.#over(e, { slot, index: e.clientY > box.top + box.height / 2 ? i + 1 : i });
      }}
      @drop=${this.#drop}
    >
      <div class="row">
        <span
          class="handle"
          aria-hidden="true"
          title="Drag to reorder or to another slot"
          draggable="true"
          @dragstart=${(e: DragEvent) => {
            this.dragging = instanceId;
            const row = (e.target as HTMLElement).closest("li");
            if (e.dataTransfer) {
              e.dataTransfer.setData("text/plain", instanceId);
              e.dataTransfer.effectAllowed = "move";
              if (row) e.dataTransfer.setDragImage(row, 12, 16);
            }
          }}
          @dragend=${() => {
            this.dragging = undefined;
            this.dropAt = undefined;
          }}
          >⋮⋮</span
        >
        <input
          type="checkbox"
          aria-label="Visible"
          .checked=${visible}
          @change=${(e: Event) =>
            this.#update(instanceId, { visible: (e.target as HTMLInputElement).checked })}
        />
        <span class="what">
          <span class="name">${instanceName(state, instanceId)}</span>
          ${label ? html`<span class="sub">${label}</span>` : nothing}
          ${broken ? html`<span class="badge error">Broken, not shown</span>` : nothing}
          ${visible ? nothing : html`<span class="badge muted">Hidden</span>`}
        </span>
        ${this.#slotSelect("Slot", slot, (to) => this.#update(instanceId, { slot: to }))}
        <span class="actions">
          <button
            aria-label="Move toward the edge"
            title="Move toward the edge"
            ?disabled=${i === 0}
            @click=${() => this.#update(instanceId, { index: i - 1 })}
          >
            ↑
          </button>
          <button
            aria-label="Move toward the centre"
            title="Move toward the centre"
            ?disabled=${i === count - 1}
            @click=${() => this.#update(instanceId, { index: i + 1 })}
          >
            ↓
          </button>
          <button
            class="danger"
            @click=${() => this.#run(instanceId, { type: "overlay.remove", payload: { instanceId } })}
          >
            Remove
          </button>
        </span>
      </div>
      ${this.errors[instanceId] ? html`<p class="error" role="alert">${this.errors[instanceId]}</p>` : nothing}
    </li>`;
  }

  #slotSelect(label: string, value: OverlaySlot, onChange: (slot: OverlaySlot) => void) {
    return html`<select
      aria-label=${label}
      @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value as OverlaySlot)}
    >
      ${slots.map((slot) => html`<option value=${slot} ?selected=${slot === value}>${slotLabels[slot]}</option>`)}
    </select>`;
  }

  #over(e: DragEvent, at: DropAt) {
    if (this.dragging === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (this.dropAt?.slot !== at.slot || this.dropAt.index !== at.index) this.dropAt = at;
  }

  #drop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const id = this.dragging;
    const at = this.dropAt;
    this.dragging = undefined;
    this.dropAt = undefined;
    const from = this.state?.overlays.find((p) => p.instanceId === id);
    if (!id || !at || !from) return;
    // Within its own slot, taking the widget out first shifts the ones after it up by one.
    const index = from.slot === at.slot && at.index > from.order ? at.index - 1 : at.index;
    if (from.slot === at.slot && index === from.order) return;
    void this.#update(id, { slot: at.slot, index });
  };

  #update(
    instanceId: string,
    changes: Omit<Extract<Command, { type: "overlay.update" }>["payload"], "instanceId">,
  ) {
    return this.#run(instanceId, { type: "overlay.update", payload: { instanceId, ...changes } });
  }

  #place = () => {
    const instanceId = this.addId;
    void this.#run("add", {
      type: "overlay.place",
      payload: { instanceId, slot: this.target },
    }).then((ok) => {
      if (ok && this.addId === instanceId) this.addId = "";
    });
  };

  async #run(key: string, command: Command): Promise<boolean> {
    const { [key]: _, ...errors } = this.errors;
    this.errors = errors;
    try {
      await send(command);
      return true;
    } catch (error) {
      this.errors = { ...this.errors, [key]: errorText(error) };
      return false;
    }
  }
}

customElements.define("sb-overlays-page", OverlaysPage);
