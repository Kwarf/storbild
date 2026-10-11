import { type Command, type Cue, isPlayableScene, type ShowState } from "@storbild/core";
import type { ViewerContext } from "@storbild/plugin-sdk/viewer";
import { css, html, LitElement, nothing, type PropertyDeclarations } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { errorText, send } from "./api.ts";
import {
  actionText,
  belowLabels,
  type CueDraft,
  cueClock,
  cueDays,
  cueOf,
  cueProblem,
  draftOf,
  emptyDraft,
  nextCue,
  relativeTime,
} from "./schedule.ts";
import { instanceName } from "./status.ts";
import { controls, page } from "./styles.ts";

/** The key of the add form, for drafts and errors. */
const ADD = "add";

/**
 * The Schedule page (DESIGN.md §8.2, ADR 0011): cues by day and time, as dense rows. A cue
 * takes or interrupts with a scene at a set time; it fires once, and a fired cue can only be
 * removed. Every edit is a command, and the rows follow the state.
 */
export class SchedulePage extends LitElement {
  static override properties: PropertyDeclarations = {
    state: { attribute: false },
    ctx: { attribute: false },
    drafts: { state: true },
    errors: { state: true },
  };

  static override styles = [
    controls,
    page,
    css`
      :host {
        max-width: 1040px;
      }
      .day {
        margin-top: 20px;
      }
      .day h2 {
        font-size: var(--sb-text-md);
        padding-bottom: 6px;
        border-bottom: 1px solid var(--sb-line);
      }
      ol {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      li {
        border-bottom: 1px solid var(--sb-line);
      }
      .row {
        display: grid;
        grid-template-columns: 72px 136px minmax(0, 1fr) auto;
        align-items: center;
        gap: 10px;
        padding: 6px 0;
      }
      li.fired .row {
        color: var(--sb-muted);
      }
      .time {
        font-weight: var(--sb-weight-strong);
      }
      .when {
        color: var(--sb-muted);
        font-size: var(--sb-text-sm);
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
      .editor {
        display: flex;
        flex-wrap: wrap;
        align-items: end;
        gap: 12px;
        padding: 4px 0 12px;
      }
      li .editor {
        padding-left: 82px;
      }
      .editor label {
        display: grid;
        gap: 4px;
        font-size: var(--sb-text-sm);
        font-weight: var(--sb-weight-strong);
      }
      .editor select.scene {
        min-width: 220px;
        max-width: 320px;
      }
      .editor input[type="text"] {
        width: 120px;
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
        margin: 16px 0 0;
      }
      .add {
        margin-top: 8px;
        border-top: 1px solid var(--sb-line);
        border-bottom: 1px solid var(--sb-line);
      }
      .top {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 12px;
        margin-top: 24px;
      }
    `,
  ];

  declare state: ShowState | undefined;
  declare ctx: ViewerContext | undefined;
  /** Open editors by cue ID, and the add form under `add`. */
  declare drafts: Record<string, CueDraft>;
  /** Errors by cue ID, or `add`/`fired`. */
  declare errors: Record<string, string>;
  #ticker: number | undefined;

  constructor() {
    super();
    this.drafts = { [ADD]: emptyDraft() };
    this.errors = {};
  }

  override connectedCallback() {
    super.connectedCallback();
    // Keeps "in 5 min" and the next marker current.
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
    if (!state || !ctx) return html`<h1>Schedule</h1><p class="muted">Connecting…</p>`;
    const now = ctx.serverNow();
    const next = nextCue(state.cues);
    const fired = state.cues.filter((cue) => cue.fired);
    return html`
      <h1>Schedule</h1>
      <p class="hint">
        Cues take or interrupt with a scene at a set time, then the rotation carries on. Each
        cue fires once.
      </p>
      <section aria-label="New cue">
        <h2>New cue</h2>
        <div class="add">${this.#editor(state, ADD)}</div>
        ${this.#error(ADD)}
      </section>
      <div class="top">
        <h2>Cues</h2>
        ${
          fired.length > 0
            ? html`<button @click=${() => this.#removeFired(fired)}>Remove fired (${fired.length})</button>`
            : nothing
        }
      </div>
      ${this.#error("fired")}
      ${
        state.cues.length === 0
          ? html`<p class="empty">Nothing is scheduled.</p>`
          : repeat(
              cueDays(state.cues, now),
              (day) => day.key,
              (day) => html`<section class="day" data-day=${day.key}>
                <h2>${day.label}</h2>
                <ol>
                  ${repeat(
                    day.cues,
                    (cue) => cue.id,
                    (cue) => this.#row(state, cue, now, cue.id === next?.id),
                  )}
                </ol>
              </section>`,
            )
      }
    `;
  }

  #row(state: ShowState, cue: Cue, now: number, isNext: boolean) {
    const { action } = cue;
    const editing = this.drafts[cue.id];
    const problem = cue.fired ? undefined : cueProblem(state, cue);
    const name =
      action.type === "activateTheme"
        ? (state.themes[action.themeId]?.name ?? "Deleted theme")
        : instanceName(state, action.instanceId);
    return html`<li class=${cue.fired ? "fired" : ""} data-cue=${cue.id}>
      <div class="row">
        <span class="time num">${cueClock(cue.at)}</span>
        <span class="when num">${relativeTime(cue.at, now)}</span>
        <span class="what">
          <span class="name">${name}</span>
          <span class="sub">${actionText(action)}</span>
          ${cue.fired ? html`<span class="badge muted">Fired</span>` : nothing}
          ${isNext ? html`<span class="badge scheduled">Next</span>` : nothing}
          ${problem ? html`<span class="badge error">${problem}</span>` : nothing}
        </span>
        <span class="actions">
          ${
            cue.fired
              ? nothing
              : html`<button
                  aria-expanded=${editing ? "true" : "false"}
                  @click=${() => this.#toggleEditor(cue)}
                >
                  Edit
                </button>`
          }
          <button
            class="danger"
            @click=${() => this.#run(cue.id, { type: "cue.delete", payload: { id: cue.id } })}
          >
            Remove
          </button>
        </span>
      </div>
      ${editing ? this.#editor(state, cue.id) : nothing} ${this.#error(cue.id)}
    </li>`;
  }

  /** The fields of a cue: the add form, or an open editor of an existing cue. */
  #editor(state: ShowState, key: string) {
    const draft = this.drafts[key] ?? emptyDraft();
    const set = (changes: Partial<CueDraft>) => {
      this.drafts = { ...this.drafts, [key]: { ...draft, ...changes } };
    };
    const value = (e: Event) => (e.target as HTMLInputElement | HTMLSelectElement).value;
    const scenes = Object.values(state.instances)
      .filter((instance) => state.plugins[instance.plugin]?.types[instance.type]?.kind === "scene")
      .sort((a, b) => a.name.localeCompare(b.name));
    return html`<div class="editor">
      <label>
        At
        <input
          type="datetime-local"
          step="1"
          .value=${draft.at}
          @change=${(e: Event) => set({ at: value(e) })}
        />
      </label>
      <label>
        Action
        <select aria-label="Action" @change=${(e: Event) => set({ type: value(e) as CueDraft["type"] })}>
          <option value="interrupt" ?selected=${draft.type === "interrupt"}>Interrupt</option>
          <option value="take" ?selected=${draft.type === "take"}>Take</option>
          <option value="activateTheme" ?selected=${draft.type === "activateTheme"}>
            Switch theme
          </option>
        </select>
      </label>
      ${
        draft.type === "activateTheme"
          ? html`<label>
              Theme
              <select class="theme" aria-label="Theme" @change=${(e: Event) => set({ themeId: value(e) })}>
                <option value="" ?selected=${draft.themeId === ""}>Choose a theme…</option>
                ${Object.values(state.themes)
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map(
                    (theme) =>
                      html`<option value=${theme.id} ?selected=${draft.themeId === theme.id}>${theme.name}</option>`,
                  )}
              </select>
            </label>`
          : html`      <label>
        Scene
        <select class="scene" aria-label="Scene" @change=${(e: Event) => set({ instanceId: value(e) })}>
          <option value="" ?selected=${draft.instanceId === ""}>Choose a scene…</option>
          ${scenes.map((instance) => {
            const playable = isPlayableScene(state, instance.id);
            return html`<option
              value=${instance.id}
              ?selected=${draft.instanceId === instance.id}
              ?disabled=${!playable}
            >
              ${instance.name}${playable ? "" : " (broken)"}
            </option>`;
          })}
        </select>
      </label>
      <label>
        Duration
        <input
          type="text"
          class="num"
          placeholder=${draft.type === "take" ? "Until resumed" : "Until dismissed"}
          .value=${draft.duration}
          @input=${(e: Event) => set({ duration: value(e) })}
        />
      </label>
      ${
        draft.type === "interrupt"
          ? html`<label>
              Beneath
              <select aria-label="Beneath" @change=${(e: Event) => set({ below: value(e) as CueDraft["below"] })}>
                ${Object.entries(belowLabels).map(
                  ([below, label]) =>
                    html`<option value=${below} ?selected=${draft.below === below}>${label}</option>`,
                )}
              </select>
            </label>`
          : nothing
      }
`
      }
      <span class="actions">
        ${
          key === ADD
            ? html`<button class="primary" @click=${() => this.#save(ADD)}>Add cue</button>`
            : html`<button class="primary" @click=${() => this.#save(key)}>Save</button>
                <button @click=${() => this.#close(key)}>Cancel</button>`
        }
      </span>
    </div>`;
  }

  #error(key: string) {
    const error = this.errors[key];
    return error ? html`<p class="error" role="alert">${error}</p>` : nothing;
  }

  #toggleEditor(cue: Cue) {
    if (this.drafts[cue.id]) return this.#close(cue.id);
    const draft = draftOf(cue);
    if (draft) this.drafts = { ...this.drafts, [cue.id]: draft };
  }

  #close(key: string) {
    const { [key]: _, ...drafts } = this.drafts;
    const { [key]: __, ...errors } = this.errors;
    this.drafts = drafts;
    this.errors = errors;
  }

  async #save(key: string) {
    const draft = this.drafts[key] ?? emptyDraft();
    const cue = cueOf(draft);
    if (typeof cue === "string") {
      this.errors = { ...this.errors, [key]: cue };
      return;
    }
    const ok = await this.#run(
      key,
      key === ADD
        ? { type: "cue.create", payload: cue }
        : { type: "cue.update", payload: { id: key, ...cue } },
    );
    if (!ok) return;
    if (key === ADD) {
      // Keep the scene and action for the next cue; the time is rarely the same.
      this.drafts = { ...this.drafts, [ADD]: { ...draft, at: "" } };
    } else {
      this.#close(key);
    }
  }

  async #removeFired(fired: Cue[]) {
    for (const cue of fired) {
      if (!(await this.#run("fired", { type: "cue.delete", payload: { id: cue.id } }))) return;
    }
  }

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

customElements.define("sb-schedule-page", SchedulePage);
