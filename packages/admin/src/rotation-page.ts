import {
  type Command,
  isPlayableScene,
  type PlaylistItem,
  resolveTimeline,
  type ShowState,
} from "@storbild/core";
import type { ViewerContext } from "@storbild/plugin-sdk/viewer";
import { css, html, LitElement, nothing, type PropertyDeclarations } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { errorText, send } from "./api.ts";
import { fromLocalInput, move, toLocalInput } from "./content.ts";
import { formatClock, formatDuration, parseDuration } from "./format.ts";
import { instanceName, typeLabel } from "./status.ts";
import { controls, page } from "./styles.ts";

const dateTime = (epochMs: number) =>
  `${new Date(epochMs).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${formatClock(epochMs)}`;

/**
 * The Rotation page (DESIGN.md §8.2): the playlist as dense rows, with drag-to-reorder,
 * inline durations, enabled toggles and time windows. Every edit is a command; the rows
 * follow the state, and the show keeps playing through edits (ADR 0006).
 */
export class RotationPage extends LitElement {
  static override properties: PropertyDeclarations = {
    state: { attribute: false },
    ctx: { attribute: false },
    errors: { state: true },
    windows: { state: true },
    dragging: { state: true },
    dropAt: { state: true },
    addId: { state: true },
  };

  static override styles = [
    controls,
    page,
    css`
      :host {
        max-width: 1040px;
      }
      ol {
        list-style: none;
        margin: 16px 0 0;
        padding: 0;
        border-top: 1px solid var(--sb-line);
      }
      li {
        position: relative;
        border-bottom: 1px solid var(--sb-line);
      }
      li.dragging {
        opacity: 0.4;
      }
      li.drop-before::before,
      li.drop-after::after {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        height: 2px;
        background: var(--sb-accent);
      }
      li.drop-before::before {
        top: -1px;
      }
      li.drop-after::after {
        bottom: -1px;
      }
      .row {
        display: grid;
        grid-template-columns: 20px 28px 24px minmax(0, 1fr) 132px auto;
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
      .pos {
        color: var(--sb-muted);
        font-size: var(--sb-text-sm);
        text-align: right;
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
      .row input[type="text"] {
        box-sizing: border-box;
        width: 100%;
      }
      .row .actions {
        gap: 4px;
        justify-content: flex-end;
      }
      .row .actions button {
        padding: 4px 8px;
      }
      .window {
        display: flex;
        flex-wrap: wrap;
        align-items: end;
        gap: 12px;
        padding: 4px 0 12px 82px;
      }
      .window label {
        display: grid;
        gap: 4px;
        font-size: var(--sb-text-sm);
        font-weight: var(--sb-weight-strong);
      }
      input[type="datetime-local"] {
        padding: 4px 8px;
        background: var(--sb-field);
        border: 1px solid var(--sb-line-strong);
        border-radius: var(--sb-radius);
        font: inherit;
        color: inherit;
        font-variant-numeric: tabular-nums;
      }
      li > .error {
        margin: 0 0 8px 82px;
      }
      .empty {
        padding: 16px 0;
        color: var(--sb-muted);
        border-bottom: 1px solid var(--sb-line);
        margin: 0;
      }
      .add {
        margin-top: 16px;
      }
      .add select {
        flex: 1 1 240px;
        max-width: 360px;
      }
    `,
  ];

  declare state: ShowState | undefined;
  declare ctx: ViewerContext | undefined;
  /** Errors by item ID, or `add`/`order`. */
  declare errors: Record<string, string>;
  /** Items whose time window editor is open. */
  declare windows: ReadonlySet<string>;
  /** The ID of the item being dragged. */
  declare dragging: string | undefined;
  /** Where a dragged row would land: before the row at this index. */
  declare dropAt: number | undefined;
  declare addId: string;
  #ticker: number | undefined;

  constructor() {
    super();
    this.errors = {};
    this.windows = new Set();
    this.addId = "";
  }

  override connectedCallback() {
    super.connectedCallback();
    // Keeps the on-air marker current.
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
    if (!state || !ctx) return html`<h1>Rotation</h1><p class="muted">Connecting…</p>`;
    const items = state.playlist.items;
    const timeline = resolveTimeline(state, ctx.serverNow());
    const scenes = Object.values(state.instances)
      .filter((instance) => state.plugins[instance.plugin]?.types[instance.type]?.kind === "scene")
      .sort((a, b) => a.name.localeCompare(b.name));
    return html`
      <h1>Rotation</h1>
      <p class="hint">
        Plays from top to bottom and loops. Items without a duration run for their type's
        length or the default of ${formatDuration(state.settings.defaultDurationMs)}.
      </p>
      ${this.errors.order ? html`<p class="error" role="alert">${this.errors.order}</p>` : nothing}
      ${
        items.length === 0
          ? html`<p class="empty">The rotation is empty. Add a scene below, or create one in the Library.</p>`
          : html`<ol
              @dragover=${this.#dragOver}
              @drop=${this.#drop}
              @dragleave=${(e: DragEvent) => {
                if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) {
                  this.dropAt = undefined;
                }
              }}
            >
              ${repeat(
                items,
                (item) => item.id,
                (item, i) =>
                  this.#row(state, item, i, {
                    onAir: timeline.main?.itemId === item.id,
                    next: timeline.next?.itemId === item.id,
                  }),
              )}
            </ol>`
      }
      <div class="actions add">
        <select
          aria-label="Scene to add"
          @change=${(e: Event) => {
            this.addId = (e.target as HTMLSelectElement).value;
          }}
        >
          <option value="" ?selected=${this.addId === ""}>Choose a scene…</option>
          ${scenes.map(
            (instance) =>
              html`<option value=${instance.id} ?selected=${this.addId === instance.id}>${instance.name}</option>`,
          )}
        </select>
        <button class="primary" ?disabled=${!this.addId} @click=${this.#add}>Add to rotation</button>
        ${
          scenes.length === 0
            ? html`<span class="muted" style="font-size: var(--sb-text-sm)">Create scenes in the Library first.</span>`
            : nothing
        }
      </div>
      ${this.errors.add ? html`<p class="error" role="alert">${this.errors.add}</p>` : nothing}
    `;
  }

  #row(state: ShowState, item: PlaylistItem, i: number, at: { onAir: boolean; next: boolean }) {
    const count = state.playlist.items.length;
    const from = this.#draggingIndex();
    const playable = isPlayableScene(state, item.instanceId);
    const open = this.windows.has(item.id);
    const hasWindow = item.activeFrom !== undefined || item.activeUntil !== undefined;
    const drop =
      from === undefined || this.dropAt === undefined
        ? ""
        : this.dropAt === i && from !== i && from !== i - 1
          ? "drop-before"
          : this.dropAt === count && i === count - 1 && from !== i
            ? "drop-after"
            : "";
    const label = typeLabel(state, item.instanceId);
    return html`<li
      class="${item.enabled ? "" : "off"} ${this.dragging === item.id ? "dragging" : ""} ${drop}"
      data-item=${item.id}
      data-index=${i}
    >
      <div class="row">
        <span
          class="handle"
          aria-hidden="true"
          title="Drag to reorder"
          draggable="true"
          @dragstart=${(e: DragEvent) => {
            this.dragging = item.id;
            const row = (e.target as HTMLElement).closest("li");
            if (e.dataTransfer) {
              e.dataTransfer.setData("text/plain", item.id);
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
        <span class="pos num">${i + 1}</span>
        <input
          type="checkbox"
          aria-label="Enabled"
          .checked=${item.enabled}
          @change=${(e: Event) =>
            this.#update(item.id, { enabled: (e.target as HTMLInputElement).checked })}
        />
        <span class="what">
          <span class="name">${instanceName(state, item.instanceId)}</span>
          ${label ? html`<span class="sub">${label}</span>` : nothing}
          ${at.onAir ? html`<span class="badge live">On air</span>` : nothing}
          ${at.next ? html`<span class="badge scheduled">Next</span>` : nothing}
          ${playable ? nothing : html`<span class="badge error">Broken, skipped</span>`}
          ${!item.enabled ? html`<span class="badge muted">Off</span>` : nothing}
          ${hasWindow && !open ? html`<span class="sub num">${this.#windowText(item)}</span>` : nothing}
        </span>
        <input
          type="text"
          class="num"
          aria-label="Duration"
          placeholder=${`${formatDuration(item.resolvedDurationMs ?? state.settings.defaultDurationMs)} auto`}
          .value=${item.durationMs === undefined ? "" : formatDuration(item.durationMs)}
          @change=${(e: Event) => this.#setDuration(item.id, e.target as HTMLInputElement)}
        />
        <span class="actions">
          <button
            aria-expanded=${open ? "true" : "false"}
            @click=${() => {
              const windows = new Set(this.windows);
              if (open) windows.delete(item.id);
              else windows.add(item.id);
              this.windows = windows;
            }}
          >
            Window
          </button>
          <button aria-label="Move up" title="Move up" ?disabled=${i === 0} @click=${() => this.#reorder(i, i - 1)}>
            ↑
          </button>
          <button
            aria-label="Move down"
            title="Move down"
            ?disabled=${i === count - 1}
            @click=${() => this.#reorder(i, i + 1)}
          >
            ↓
          </button>
          <button class="danger" @click=${() => this.#run(item.id, { type: "playlist.removeItem", payload: { id: item.id } })}>
            Remove
          </button>
        </span>
      </div>
      ${
        open
          ? html`<div class="window">
              ${(["activeFrom", "activeUntil"] as const).map(
                (key) => html`<label>
                  ${key === "activeFrom" ? "Active from" : "Active until"}
                  <input
                    type="datetime-local"
                    data-window=${key}
                    .value=${toLocalInput(item[key])}
                    @change=${(e: Event) =>
                      this.#update(item.id, {
                        [key]: fromLocalInput((e.target as HTMLInputElement).value) ?? null,
                      })}
                  />
                </label>`,
              )}
              <span class="muted" style="font-size: var(--sb-text-sm)">Blank means no limit.</span>
            </div>`
          : nothing
      }
      ${this.errors[item.id] ? html`<p class="error" role="alert">${this.errors[item.id]}</p>` : nothing}
    </li>`;
  }

  #windowText(item: PlaylistItem) {
    const from = item.activeFrom === undefined ? "" : `from ${dateTime(item.activeFrom)}`;
    const until = item.activeUntil === undefined ? "" : `until ${dateTime(item.activeUntil)}`;
    return [from, until].filter(Boolean).join(" ");
  }

  #setDuration(id: string, input: HTMLInputElement) {
    const ms = parseDuration(input.value);
    if (ms === null) {
      this.errors = {
        ...this.errors,
        [id]: "Enter a duration as seconds or m:ss, or leave it blank.",
      };
      return;
    }
    void this.#update(id, { durationMs: ms ?? null });
  }

  #update(
    id: string,
    changes: Omit<Extract<Command, { type: "playlist.updateItem" }>["payload"], "id">,
  ) {
    return this.#run(id, { type: "playlist.updateItem", payload: { id, ...changes } });
  }

  #reorder(from: number, to: number) {
    const ids = this.state?.playlist.items.map((item) => item.id) ?? [];
    if (from === to || to < 0 || to >= ids.length) return;
    void this.#run("order", {
      type: "playlist.reorder",
      payload: { itemIds: move(ids, from, to) },
    });
  }

  /** The dragged item's current index, which a patch may have moved mid-drag. */
  #draggingIndex() {
    const index = this.state?.playlist.items.findIndex((item) => item.id === this.dragging) ?? -1;
    return index === -1 ? undefined : index;
  }

  #dragOver = (e: DragEvent) => {
    if (this.dragging === undefined) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const row = (e.target as HTMLElement).closest("li");
    if (!row) return;
    const index = Number(row.dataset.index);
    const box = row.getBoundingClientRect();
    this.dropAt = e.clientY > box.top + box.height / 2 ? index + 1 : index;
  };

  #drop = (e: DragEvent) => {
    e.preventDefault();
    const from = this.#draggingIndex();
    const at = this.dropAt;
    this.dragging = undefined;
    this.dropAt = undefined;
    if (from === undefined || at === undefined) return;
    // Removing the dragged row first shifts the rows after it up by one.
    this.#reorder(from, at > from ? at - 1 : at);
  };

  #add = () => {
    const instanceId = this.addId;
    void this.#run("add", { type: "playlist.addItem", payload: { instanceId } }).then((ok) => {
      // Unless another scene was chosen meanwhile.
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

customElements.define("sb-rotation-page", RotationPage);
