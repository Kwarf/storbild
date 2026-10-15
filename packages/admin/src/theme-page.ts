import type { Instance, Issue, ShowState, Theme, ThemeBackground } from "@storbild/core";
import "@storbild/plugin-sdk/admin";
import type { ValueChangeEvent } from "@storbild/plugin-sdk/admin";
import type { ViewerContext } from "@storbild/plugin-sdk/viewer";
import "@storbild/viewer";
import { css, html, LitElement, nothing, type PropertyDeclarations } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { CommandFailed, errorText, send } from "./api.ts";
import { sameValue } from "./content.ts";
import { controls, page } from "./styles.ts";
import {
  backgroundField,
  backgroundTypes,
  draftOf,
  duplicateOf,
  switchBackground,
  type ThemeDraft,
  themeFields,
  themePayload,
  themePreviewState,
  widgetsOf,
} from "./theme-form.ts";

/** What the preview shows when nothing is on air, if the markdown plugin is loaded. */
function sampleScene(state: ShowState): Instance | undefined {
  if (state.plugins.markdown?.types.text?.kind !== "scene") return undefined;
  return {
    id: "theme-sample",
    plugin: "markdown",
    type: "text",
    name: "Sample",
    config: {
      title: "Welcome to the party",
      content: "Doors open at 18:00.\nCompos start at 20:00.",
    },
    configVersion: 1,
  };
}

/** Issues under `key`, with it taken off their paths. */
const issuesBelow = (issues: Issue[], key: string) =>
  issues
    .filter((issue) => issue.path[0] === key)
    .map((issue) => ({ ...issue, path: issue.path.slice(1) }));

/**
 * The Theme page (DESIGN.md §8.2, ADR 0014): the stored themes, and an editor for one of them
 * next to a live preview of the show in the edited look. One theme is active at a time.
 */
export class ThemePage extends LitElement {
  static override properties: PropertyDeclarations = {
    state: { attribute: false },
    ctx: { attribute: false },
    selected: { state: true },
    draft: { state: true },
    issues: { state: true },
    error: { state: true },
    busy: { state: true },
    confirmDelete: { state: true },
  };

  static override styles = [
    controls,
    page,
    css`
      :host {
        display: grid;
        grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
        align-items: start;
        gap: 0 28px;
      }
      @media (max-width: 960px) {
        :host {
          grid-template-columns: minmax(0, 1fr);
          gap: 24px;
        }
      }
      .list-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 12px;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        border-top: 1px solid var(--sb-line);
      }
      li button {
        display: flex;
        width: 100%;
        justify-content: space-between;
        gap: 8px;
        padding: 7px 10px;
        border: 0;
        border-bottom: 1px solid var(--sb-line);
        border-left: 3px solid transparent;
        border-radius: 0;
        background: none;
        font-size: var(--sb-text-md);
        font-weight: var(--sb-weight);
        text-align: left;
      }
      li button:hover:not(:disabled) {
        background: var(--sb-bg-sunken);
        border-color: var(--sb-line);
        border-left-color: transparent;
      }
      li button[aria-current="true"] {
        border-left-color: var(--sb-accent);
        background: var(--sb-bg-sunken);
        font-weight: var(--sb-weight-strong);
      }
      li .name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .swatches {
        display: inline-flex;
        flex: none;
        gap: 2px;
      }
      .swatches span {
        width: 12px;
        height: 12px;
        border: 1px solid var(--sb-line-strong);
        border-radius: 2px;
      }
      .panel {
        display: grid;
        gap: 16px;
        max-width: 960px;
      }
      /* The form beside a preview that stays in view while it scrolls. */
      .body {
        display: grid;
        grid-template-columns: minmax(0, 420px) minmax(0, 1fr);
        grid-template-areas: "form side";
        align-items: start;
        gap: 24px;
      }
      .form {
        grid-area: form;
        display: grid;
        gap: 16px;
      }
      .side {
        grid-area: side;
        position: sticky;
        top: 12px;
        display: grid;
        gap: 6px;
      }
      @media (max-width: 1280px) {
        .body {
          grid-template-columns: minmax(0, 1fr);
          grid-template-areas: "side" "form";
        }
        .side {
          position: static;
        }
      }
      .panel-head {
        display: flex;
        align-items: baseline;
        gap: 10px;
        flex-wrap: wrap;
      }
      section {
        display: grid;
        gap: 12px;
        padding-top: 12px;
        border-top: 1px solid var(--sb-line);
      }
      section h3 {
        margin: 0;
        font-size: var(--sb-text-md);
        font-weight: var(--sb-weight-strong);
      }
      .field {
        display: grid;
        gap: 4px;
        max-width: 360px;
      }
      .hint {
        margin: 0;
      }
      textarea.css {
        font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
        font-size: var(--sb-text-sm);
        min-height: 96px;
        max-width: 100%;
        resize: vertical;
      }
      .preview {
        width: 100%;
        max-width: 480px;
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
      .bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding-top: 12px;
        border-top: 1px solid var(--sb-line);
      }
      .bar .spacer {
        flex: 1;
      }
    `,
  ];

  declare state: ShowState | undefined;
  declare ctx: ViewerContext | undefined;
  /** The theme being edited, `new` while creating one, or nothing. */
  declare selected: string | undefined;
  declare draft: ThemeDraft | undefined;
  declare issues: Issue[];
  declare error: string | undefined;
  declare busy: boolean;
  declare confirmDelete: boolean;
  /** The stored theme the draft was made from; edits are what differ from it. */
  #base: Theme | undefined;
  /** A theme just created, selected before its patch has arrived. */
  #awaiting: string | undefined;

  constructor() {
    super();
    this.issues = [];
    this.busy = false;
    this.confirmDelete = false;
  }

  protected override willUpdate() {
    const state = this.state;
    if (!state) return;
    // Open on the active theme.
    if (this.selected === undefined && this.draft === undefined) this.#select(state.activeThemeId);
    if (this.selected === undefined || this.selected === "new") return;
    const theme = state.themes[this.selected];
    if (!theme) {
      if (this.selected !== this.#awaiting) this.#select(state.activeThemeId);
      return;
    }
    if (this.selected === this.#awaiting) this.#awaiting = undefined;
    // Follow changes made elsewhere (or a save's patch) while there's nothing unsaved here.
    if (!this.draft || (theme !== this.#base && !this.#dirty())) {
      this.#base = theme;
      this.draft = draftOf(theme);
    }
  }

  override render() {
    const state = this.state;
    if (!state) return html`<div><h1>Theme</h1><p class="muted">Connecting…</p></div>`;
    return html`${this.#list(state)}${this.#panel(state)}`;
  }

  #list(state: ShowState) {
    const themes = Object.values(state.themes).sort((a, b) => a.name.localeCompare(b.name));
    return html`<div>
      <div class="list-head">
        <h1>Theme</h1>
        <button class="primary" @click=${this.#startNew}>New theme</button>
      </div>
      <ul>
        ${repeat(
          themes,
          (theme) => theme.id,
          (theme) => html`<li>
            <button
              aria-current=${this.selected === theme.id ? "true" : "false"}
              data-theme=${theme.id}
              @click=${() => this.#select(theme.id)}
            >
              <span class="name">${theme.name}</span>
              ${
                theme.id === state.activeThemeId
                  ? html`<span class="badge live">Active</span>`
                  : html`<span class="swatches" aria-hidden="true">
                      ${[theme.colors.text, theme.colors.accent, theme.colors.surface].map(
                        (color) => html`<span style="background: ${color}"></span>`,
                      )}
                    </span>`
              }
            </button>
          </li>`,
        )}
      </ul>
    </div>`;
  }

  #panel(state: ShowState) {
    const draft = this.draft;
    if (!draft)
      return html`<div class="panel"><p class="hint">Select a theme to edit it.</p></div>`;
    const creating = draft.id === undefined;
    const active = draft.id === state.activeThemeId;
    const dirty = this.#dirty();
    const set = (changes: Partial<ThemeDraft>) => {
      this.draft = { ...draft, ...changes };
    };
    return html`<div class="panel" aria-label="Theme editor">
      <div class="panel-head">
        <h2>${creating ? "New theme" : (this.#base?.name ?? draft.name)}</h2>
        ${active ? html`<span class="badge live">Active</span>` : nothing}
      </div>
      <label class="field">
        Name
        <input
          type="text"
          name="name"
          .value=${draft.name}
          @input=${(e: Event) => set({ name: (e.target as HTMLInputElement).value })}
        />
      </label>
      <div class="body">
      <div class="side">
        <div class="preview" aria-label="Preview">
          <sb-stage
            ><sb-compositor
              .state=${themePreviewState(state, draft, sampleScene(state))}
              .ctx=${this.ctx}
            ></sb-compositor
          ></sb-stage>
        </div>
        <p class="hint">What is on air now, in this theme.</p>
      </div>
      <div class="form">
      ${this.#background(state, draft, set)}
      ${themeFields.map(({ key, label, field }) => {
        const value =
          key === "layout"
            ? { safeArea: draft.safeArea, gap: draft.gap }
            : key === "widgets"
              ? (draft.widgets ?? {})
              : key === "colors"
                ? draft.colors
                : draft.fonts;
        // The layout fields are top-level in the theme, so their issues keep their paths.
        const issues =
          key === "layout"
            ? this.issues.filter((issue) => issue.path[0] === "safeArea" || issue.path[0] === "gap")
            : issuesBelow(this.issues, key);
        return html`<section data-section=${key}>
          <h3>${label}</h3>
          <sb-field
            .field=${field}
            .value=${value}
            .issues=${issues}
            @change=${(e: ValueChangeEvent) => {
              e.stopPropagation();
              const next = e.detail.value as Record<string, unknown>;
              if (key === "layout") {
                const { safeArea: _, gap: __, ...rest } = draft;
                this.draft = {
                  ...rest,
                  ...(typeof next.safeArea === "number" && { safeArea: next.safeArea }),
                  ...(typeof next.gap === "number" && { gap: next.gap }),
                };
              } else if (key === "widgets") {
                const { widgets: _, ...rest } = draft;
                const widgets = widgetsOf(next);
                this.draft = widgets ? { ...rest, widgets } : rest;
              } else {
                set({ [key]: next } as Partial<ThemeDraft>);
              }
            }}
          ></sb-field>
        </section>`;
      })}
      <section data-section="css">
        <h3><label for="custom-css">Custom CSS</label></h3>
        <p class="hint">
          Applied on the screens inside the compositor, after its own styles. At your own risk.
        </p>
        <textarea
            id="custom-css"
            class="css"
            name="customCss"
            spellcheck="false"
            .value=${draft.customCss ?? ""}
            @input=${(e: Event) => {
              const value = (e.target as HTMLTextAreaElement).value;
              const { customCss: _, ...rest } = draft;
              this.draft = value ? { ...rest, customCss: value } : rest;
            }}
          ></textarea>
      </section>
      </div>
      </div>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      <div class="bar">
        ${
          creating
            ? html`<button class="primary" ?disabled=${this.busy || !draft.name.trim()} @click=${this.#create}>
                  Create
                </button>
                <button @click=${() => this.#select(state.activeThemeId)}>Cancel</button>`
            : html`<button class="primary" ?disabled=${this.busy || !dirty || !draft.name.trim()} @click=${this.#save}>
                  Save
                </button>
                <button ?disabled=${this.busy || !dirty} @click=${this.#revert}>Revert</button>
                <button ?disabled=${this.busy || active || dirty} @click=${this.#activate}
                  title=${dirty ? "Save first" : nothing}>
                  Activate
                </button>
                <button ?disabled=${this.busy} @click=${this.#duplicate}>Duplicate</button>
                <span class="spacer"></span>
                ${this.#deleteControl(active)}`
        }
      </div>
    </div>`;
  }

  #background(state: ShowState, draft: ThemeDraft, set: (changes: Partial<ThemeDraft>) => void) {
    const background = draft.background;
    const { type, ...rest } = background;
    return html`<section data-section="background">
      <h3>Background</h3>
      <label class="field">
        Type
        <select
          name="backgroundType"
          @change=${(e: Event) => {
            const next = (e.target as HTMLSelectElement).value as ThemeBackground["type"];
            set({ background: switchBackground(state, background, next) });
          }}
        >
          ${backgroundTypes.map(
            (option) =>
              html`<option value=${option.type} ?selected=${option.type === type}>${option.label}</option>`,
          )}
        </select>
      </label>
      <sb-field
        .field=${backgroundField(state, type)}
        .value=${rest}
        .issues=${issuesBelow(this.issues, "background")}
        @change=${(e: ValueChangeEvent) => {
          e.stopPropagation();
          set({ background: { ...(e.detail.value as object), type } as ThemeBackground });
        }}
      ></sb-field>
    </section>`;
  }

  #deleteControl(active: boolean) {
    if (!this.confirmDelete) {
      return html`<button
        class="danger"
        ?disabled=${this.busy || active}
        title=${active ? "Activate another theme first" : nothing}
        @click=${() => {
          this.confirmDelete = true;
        }}
      >
        Delete
      </button>`;
    }
    return html`<span class="muted" role="status">Delete this theme?</span>
      <button class="danger" ?disabled=${this.busy} @click=${this.#delete}>Delete</button>
      <button @click=${() => {
        this.confirmDelete = false;
      }}>Keep</button>`;
  }

  #dirty(): boolean {
    const draft = this.draft;
    if (!draft || draft.id === undefined) return draft !== undefined;
    const base = this.#base;
    return !base || !sameValue(draft, base);
  }

  #select(id: string | undefined) {
    this.selected = id;
    this.draft = undefined;
    this.#base = undefined;
    this.issues = [];
    this.error = undefined;
    this.confirmDelete = false;
    const theme = id === undefined ? undefined : this.state?.themes[id];
    if (theme) {
      this.#base = theme;
      this.draft = draftOf(theme);
    }
  }

  #startNew = () => {
    const active = this.state?.themes[this.state.activeThemeId];
    this.#select("new");
    // A new theme starts from the active one, so it only needs what differs.
    this.draft = active
      ? { ...duplicateOf(active), name: "" }
      : {
          name: "",
          background: { type: "color", color: "#000000" },
          fonts: { heading: { family: "sans-serif" }, body: { family: "sans-serif" } },
          colors: { text: "#ffffff", muted: "#a0a0a0", accent: "#ffcc00", surface: "#1a1a1a" },
        };
  };

  #duplicate = () => {
    const draft = this.draft;
    if (!draft) return;
    this.#select("new");
    this.draft = duplicateOf(draft);
  };

  async #run(action: () => Promise<void>) {
    this.busy = true;
    this.error = undefined;
    this.issues = [];
    try {
      await action();
    } catch (error) {
      this.error = errorText(error);
      if (error instanceof CommandFailed) this.issues = error.issues;
    } finally {
      this.busy = false;
    }
  }

  #create = () => {
    const draft = this.draft;
    if (!draft) return;
    void this.#run(async () => {
      const { safeArea, gap, widgets, customCss, ...payload } = themePayload(draft);
      const { id } = await send({
        type: "theme.create",
        payload: {
          ...payload,
          ...(safeArea !== null && { safeArea }),
          ...(gap !== null && { gap }),
          ...(widgets !== null && { widgets }),
          ...(customCss !== null && { customCss }),
        },
      });
      if (id) {
        this.#awaiting = id;
        this.#select(id);
      }
    });
  };

  #save = () => {
    const id = this.draft?.id;
    const draft = this.draft;
    if (!id || !draft) return;
    void this.#run(async () => {
      await send({ type: "theme.update", payload: { id, ...themePayload(draft) } });
      // Pick up what the server stored, now or when its patch arrives.
      this.draft = undefined;
      this.#base = undefined;
    });
  };

  #revert = () => {
    const id = this.draft?.id;
    if (id) this.#select(id);
  };

  #activate = () => {
    const id = this.draft?.id;
    if (id)
      void this.#run(async () => void (await send({ type: "theme.activate", payload: { id } })));
  };

  #delete = () => {
    const id = this.draft?.id;
    if (!id) return;
    void this.#run(async () => {
      await send({ type: "theme.delete", payload: { id } });
      this.#select(this.state?.activeThemeId);
    });
  };
}

customElements.define("sb-theme-page", ThemePage);
