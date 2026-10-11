import type { Instance, InstanceBackground, Issue, ShowState } from "@storbild/core";
import "@storbild/plugin-sdk/admin";
import {
  describeForm,
  type Field,
  initialValue,
  type ValueChangeEvent,
} from "@storbild/plugin-sdk/admin";
import type { ViewerContext } from "@storbild/plugin-sdk/viewer";
import "@storbild/viewer";
import { css, html, LitElement, nothing, type PropertyDeclarations } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { html as staticHtml, unsafeStatic } from "lit/static-html.js";
import { CommandFailed, errorText, type Schemas, send } from "./api.ts";
import "./asset-panel.ts";
import { sizeText } from "./asset-panel.ts";
import { uploadAsset } from "./assets.ts";
import {
  byKind,
  groupInstances,
  type InstanceGroup,
  previewState,
  rotationCount,
  sameValue,
  type TypeChoice,
  typeChoices,
} from "./content.ts";
import { controls, page } from "./styles.ts";

interface Draft {
  /** Absent for an instance that hasn't been created yet. */
  id?: string;
  plugin: string;
  type: string;
  name: string;
  config: unknown;
  /** Absent: the type's default (DESIGN.md §4.6). */
  background?: InstanceBackground;
}

/** An instance's own image background (ADR 0014). */
const imageBackgroundField: Field = {
  kind: "object",
  label: "",
  required: true,
  nullable: false,
  properties: [
    {
      key: "assetId",
      field: {
        kind: "asset",
        accept: ["image/*"],
        label: "Image",
        required: true,
        nullable: false,
      },
    },
    {
      key: "fit",
      field: {
        kind: "select",
        label: "Fit",
        options: [
          { value: "cover", label: "Fill the screen" },
          { value: "contain", label: "Show it whole" },
        ],
        required: true,
        nullable: false,
      },
    },
  ],
};

/** The selection of an uploaded file is this prefix plus its ID. */
const ASSET = "asset:";

/** Admin modules by URL; each is imported once. */
const editorModules = new Map<string, Promise<boolean>>();

function loadEditorModule(url: string): Promise<boolean> {
  let loading = editorModules.get(url);
  if (!loading) {
    loading = import(url).then(
      () => true,
      (error: unknown) => {
        console.error(`custom editor module ${url} failed to load`, error);
        return false;
      },
    );
    editorModules.set(url, loading);
  }
  return loading;
}

/**
 * The Library (DESIGN.md §8.2): instances grouped by type, and a panel that creates or edits
 * one with its plugin's generated form or custom editor, next to a live preview. Uploaded files
 * are listed under the instances, with a panel of their own (ADR 0011).
 */
export class LibraryPage extends LitElement {
  static override properties: PropertyDeclarations = {
    state: { attribute: false },
    ctx: { attribute: false },
    schemas: { attribute: false },
    selected: { state: true },
    draft: { state: true },
    issues: { state: true },
    error: { state: true },
    busy: { state: true },
    confirmDelete: { state: true },
    editorReady: { state: true },
    uploading: { state: true },
    uploadError: { state: true },
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
      .kind + .kind,
      .kind + .files {
        margin-top: 28px;
      }
      .kind > h2,
      .files h2 {
        font-size: var(--sb-text-md);
      }
      .group {
        margin-top: 14px;
      }
      .kind > h2 + .group {
        margin-top: 8px;
      }
      .group h3 {
        margin: 0;
        padding: 0 0 4px;
        font-size: var(--sb-text-xs);
        font-weight: var(--sb-weight-strong);
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--sb-muted);
        border-bottom: 1px solid var(--sb-line);
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
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
      li .meta {
        flex: none;
        color: var(--sb-muted);
        font-size: var(--sb-text-sm);
        font-weight: var(--sb-weight);
      }
      .empty {
        color: var(--sb-muted);
        padding: 12px 0;
      }
      .panel {
        display: grid;
        gap: 16px;
        max-width: 760px;
      }
      .panel-head {
        display: flex;
        align-items: baseline;
        gap: 10px;
        flex-wrap: wrap;
      }
      .panel-head .type {
        color: var(--sb-muted);
        font-size: var(--sb-text-sm);
      }
      .background {
        display: grid;
        gap: 12px;
        max-width: 360px;
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
      select.types {
        max-width: 360px;
      }
      .group-head {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 8px;
        border-bottom: 1px solid var(--sb-line);
      }
      .group-head h2 {
        padding-bottom: 4px;
      }
      .group-head button {
        margin-bottom: 4px;
        padding: 2px 8px;
      }
      .group > .error {
        margin: 6px 0 0;
      }
      input[type="file"] {
        display: none;
      }
    `,
  ];

  declare state: ShowState | undefined;
  declare ctx: ViewerContext | undefined;
  declare schemas: Schemas | undefined;
  /** The instance being edited, `new` while creating one, or nothing. */
  declare selected: string | undefined;
  declare draft: Draft | undefined;
  declare issues: Issue[];
  declare error: string | undefined;
  declare busy: boolean;
  declare confirmDelete: boolean;
  /** The custom editor's module has loaded (true), failed (false), or is loading (undefined). */
  declare editorReady: boolean | undefined;
  declare uploading: boolean;
  declare uploadError: string | undefined;
  /** The stored instance the draft was made from; edits are what differ from it. */
  #base: Instance | undefined;
  /** An instance just created, selected before its patch has arrived. */
  #awaiting: string | undefined;

  constructor() {
    super();
    this.issues = [];
    this.busy = false;
    this.confirmDelete = false;
    this.uploading = false;
  }

  protected override willUpdate() {
    const state = this.state;
    if (!state || this.selected === undefined || this.selected === "new") return;
    if (this.selected.startsWith(ASSET)) {
      const id = this.selected.slice(ASSET.length);
      if (state.assets[id]) {
        if (this.selected === this.#awaiting) this.#awaiting = undefined;
      } else if (this.selected !== this.#awaiting) {
        this.#select(undefined);
      }
      return;
    }
    const instance = state.instances[this.selected];
    if (!instance) {
      // Deleted, here or elsewhere.
      if (this.selected !== this.#awaiting) this.#select(undefined);
      return;
    }
    if (this.selected === this.#awaiting) this.#awaiting = undefined;
    // Follow changes made elsewhere (or a save's patch) while there's nothing unsaved here.
    if (!this.draft || (instance !== this.#base && !this.#dirty())) {
      this.draft = this.#draftOf(instance);
    }
  }

  override render() {
    const state = this.state;
    if (!state) return html`<div><h1>Library</h1><p class="muted">Connecting…</p></div>`;
    return html`${this.#list(state)}${this.#panel(state)}`;
  }

  #list(state: ShowState) {
    const groups = groupInstances(state);
    return html`<div>
      <div class="list-head">
        <h1>Library</h1>
        <button class="primary" @click=${() => this.#startNew()}>New instance</button>
      </div>
      ${
        groups.length === 0
          ? html`<p class="empty">No instances yet. Create one to show it on screen.</p>`
          : byKind(groups).map(
              (section) => html`<section class="kind" data-kind=${section.kind ?? "unavailable"}>
                <h2>${section.label}</h2>
                ${section.items.map((group) => this.#group(state, group))}
              </section>`,
            )
      }
      ${this.#files(state)}
    </div>`;
  }

  #group(state: ShowState, group: InstanceGroup) {
    return html`<section class="group" data-group=${group.key}>
      <h3>${group.label}</h3>
      <ul>
        ${repeat(
          group.instances,
          (instance) => instance.id,
          (instance) => {
            const uses = rotationCount(state, instance.id);
            return html`<li>
            <button
              aria-current=${this.selected === instance.id ? "true" : "false"}
              data-instance=${instance.id}
              @click=${() => this.#select(instance.id)}
            >
              <span class="name">${instance.name}</span>
              ${
                instance.error !== undefined
                  ? html`<span class="badge error">Broken</span>`
                  : uses > 0
                    ? html`<span class="meta num">In rotation${uses > 1 ? ` ×${uses}` : ""}</span>`
                    : nothing
              }
            </button>
          </li>`;
          },
        )}
      </ul>
    </section>`;
  }

  #files(state: ShowState) {
    const assets = Object.values(state.assets).sort((a, b) => a.name.localeCompare(b.name));
    return html`<section class="group files" data-group="files">
      <div class="group-head">
        <h2>Files</h2>
        <button
          ?disabled=${this.uploading}
          @click=${() => this.renderRoot.querySelector<HTMLInputElement>("input[type=file]")?.click()}
        >
          ${this.uploading ? "Uploading…" : "Upload…"}
        </button>
        <input type="file" aria-label="Upload a file" @change=${this.#upload} />
      </div>
      ${this.uploadError ? html`<p class="error" role="alert">${this.uploadError}</p>` : nothing}
      ${
        assets.length === 0
          ? html`<p class="empty">No files yet. Upload images to use them in scenes.</p>`
          : html`<ul>
              ${repeat(
                assets,
                (asset) => asset.id,
                (asset) => html`<li>
                  <button
                    aria-current=${this.selected === ASSET + asset.id ? "true" : "false"}
                    data-asset=${asset.id}
                    @click=${() => this.#select(ASSET + asset.id)}
                  >
                    <span class="name">${asset.name}</span>
                    <span class="meta num">
                      ${asset.width && asset.height ? `${asset.width}×${asset.height}` : sizeText(asset.size)}
                    </span>
                  </button>
                </li>`,
              )}
            </ul>`
      }
    </section>`;
  }

  #upload = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    this.uploading = true;
    this.uploadError = undefined;
    try {
      const asset = await uploadAsset(file);
      this.#awaiting = ASSET + asset.id;
      this.#select(ASSET + asset.id);
    } catch (error) {
      this.uploadError = errorText(error);
    } finally {
      this.uploading = false;
    }
  };

  #panel(state: ShowState) {
    if (this.selected === undefined) {
      return html`<div class="panel">
        <p class="hint">Select an instance to edit it, or create a new one.</p>
      </div>`;
    }
    if (this.selected.startsWith(ASSET)) {
      const asset = state.assets[this.selected.slice(ASSET.length)];
      return asset
        ? html`<sb-asset-panel aria-label="File" .state=${state} .asset=${asset}></sb-asset-panel>`
        : nothing;
    }
    if (this.selected === "new" && !this.draft) return this.#typePicker(state);
    const draft = this.draft;
    if (!draft) return nothing;
    const instance = draft.id === undefined ? undefined : state.instances[draft.id];
    const info = state.plugins[draft.plugin]?.types[draft.type];
    const schema = this.schemas?.[draft.plugin]?.types[draft.type];
    const creating = draft.id === undefined;
    const dirty = this.#dirty();
    return html`<div class="panel" aria-label="Instance editor">
      <div class="panel-head">
        <h2>${creating ? "New instance" : instance?.name}</h2>
        <span class="type">${info?.label ?? `${draft.plugin}/${draft.type}`}</span>
      </div>
      ${instance?.error !== undefined ? html`<p class="notice" role="status">${instance?.error}</p>` : nothing}
      <label class="field">
        Name
        <input
          type="text"
          name="name"
          .value=${draft.name}
          @input=${(e: Event) => {
            this.draft = { ...draft, name: (e.target as HTMLInputElement).value };
          }}
        />
      </label>
      ${this.#editor(state, draft, schema)}
      ${info?.kind === "scene" ? this.#background(draft, info.background === "own") : nothing}
      ${
        info
          ? html`<div>
              <div class="preview" aria-label="Preview">
                <sb-stage
                  ><sb-compositor .state=${previewState(state, draft)} .ctx=${this.ctx}></sb-compositor
                ></sb-stage>
              </div>
            </div>`
          : nothing
      }
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      <div class="bar">
        ${
          creating
            ? html`<button class="primary" ?disabled=${this.busy || !draft.name.trim()} @click=${this.#create}>
                  Create
                </button>
                <button @click=${() => this.#select(undefined)}>Cancel</button>`
            : html`<button class="primary" ?disabled=${this.busy || !dirty || !draft.name.trim()} @click=${this.#save}>
                  Save
                </button>
                <button ?disabled=${this.busy || !dirty} @click=${this.#revert}>Revert</button>
                ${
                  info?.kind === "scene"
                    ? html`<button ?disabled=${this.busy} @click=${this.#addToRotation}>Add to rotation</button>`
                    : nothing
                }
                <span class="spacer"></span>
                ${this.#deleteControl(state, draft.id as string)}`
        }
      </div>
    </div>`;
  }

  #typePicker(state: ShowState) {
    const choices = typeChoices(state);
    return html`<div class="panel" aria-label="Instance editor">
      <h2>New instance</h2>
      <p class="hint">Choose what kind of content to create.</p>
      ${
        choices.length === 0
          ? html`<p class="notice">No plugin offers an instance type. Check the Plugins page.</p>`
          : html`<div class="actions">
              <select
                class="types"
                aria-label="Instance type"
                @change=${(e: Event) => {
                  const choice = choices[Number((e.target as HTMLSelectElement).value)];
                  if (choice) this.#startDraft(choice);
                }}
              >
                <option value="" selected>Choose a type…</option>
                ${byKind(choices).map(
                  (section) => html`<optgroup label=${section.label}>
                    ${section.items.map(
                      (choice) =>
                        html`<option value=${choices.indexOf(choice)} ?disabled=${choice.taken}>
                          ${choice.label}${choice.taken ? " (exists)" : ""}
                        </option>`,
                    )}
                  </optgroup>`,
                )}
              </select>
              <button @click=${() => this.#select(undefined)}>Cancel</button>
            </div>`
      }
    </div>`;
  }

  /** What the scene shows behind itself: the theme's background, nothing, or an image. */
  #background(draft: Draft, own: boolean) {
    const background = draft.background;
    const mode = typeof background === "object" ? "image" : (background ?? "default");
    const set = (next: InstanceBackground | undefined) => {
      const { background: _, ...rest } = draft;
      this.draft = next === undefined ? rest : { ...rest, background: next };
    };
    return html`<div class="background" data-section="background">
      <label class="field">
        Background
        <select
          name="background"
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            set(
              value === "image"
                ? { assetId: "", fit: "cover" }
                : value === "theme" || value === "none"
                  ? value
                  : undefined,
            );
          }}
        >
          <option value="default" ?selected=${mode === "default"}>
            ${own ? "Its own (the type's default)" : "The theme's (the default)"}
          </option>
          ${own ? html`<option value="theme" ?selected=${mode === "theme"}>The theme's</option>` : nothing}
          ${own ? nothing : html`<option value="none" ?selected=${mode === "none"}>None (black)</option>`}
          <option value="image" ?selected=${mode === "image"}>An image</option>
        </select>
      </label>
      ${
        typeof background === "object"
          ? html`<sb-field
              .field=${imageBackgroundField}
              .value=${background}
              .issues=${this.issues
                .filter((issue) => issue.path[0] === "background")
                .map((issue) => ({ ...issue, path: issue.path.slice(1) }))}
              @change=${(e: ValueChangeEvent) => {
                e.stopPropagation();
                set(e.detail.value as InstanceBackground);
              }}
            ></sb-field>`
          : nothing
      }
    </div>`;
  }

  /** The plugin's custom editor when it has one that loads, else the generated form. */
  #editor(state: ShowState, draft: Draft, schema: Schemas[string]["types"][string] | undefined) {
    const entry = state.plugins[draft.plugin];
    const editor = entry?.types[draft.type]?.editor;
    const onChange = (e: ValueChangeEvent) => {
      e.stopPropagation();
      this.draft = { ...draft, config: e.detail.value };
    };
    if (editor && entry?.adminModule) {
      if (this.editorReady === undefined) {
        void loadEditorModule(entry.adminModule).then((ok) => {
          this.editorReady = ok && customElements.get(editor) !== undefined;
        });
      } else if (this.editorReady) {
        const tag = unsafeStatic(editor);
        return staticHtml`<${tag}
          data-editor
          .value=${draft.config}
          .schema=${schema ?? {}}
          .settings=${entry.settings}
          .issues=${this.issues}
          @change=${onChange}
        ></${tag}>`;
      }
    }
    if (!schema) {
      return html`<p class="notice">This type's plugin is unavailable, so its config can't be edited.</p>`;
    }
    return html`${
      editor && this.editorReady === false
        ? html`<p class="notice info">The plugin's editor didn't load; showing a generated form.</p>`
        : nothing
    }
      <sb-form .schema=${schema} .value=${draft.config} .issues=${this.issues} @change=${onChange}></sb-form>`;
  }

  #deleteControl(state: ShowState, id: string) {
    if (!this.confirmDelete) {
      return html`<button class="danger" ?disabled=${this.busy} @click=${() => {
        this.confirmDelete = true;
      }}>Delete</button>`;
    }
    const uses = rotationCount(state, id);
    return html`<span class="muted" role="status"
        >Delete${uses > 0 ? ` and remove from ${uses} rotation item${uses > 1 ? "s" : ""}` : ""}?</span
      >
      <button class="danger" ?disabled=${this.busy} @click=${this.#delete}>Delete</button>
      <button @click=${() => {
        this.confirmDelete = false;
      }}>Keep</button>`;
  }

  #draftOf(instance: Instance): Draft {
    this.#base = instance;
    return {
      id: instance.id,
      plugin: instance.plugin,
      type: instance.type,
      name: instance.name,
      config: structuredClone(instance.config),
      ...(instance.background !== undefined && {
        background: structuredClone(instance.background),
      }),
    };
  }

  #dirty(): boolean {
    const draft = this.draft;
    if (!draft || draft.id === undefined) return draft !== undefined;
    const base = this.#base;
    return (
      !base ||
      draft.name !== base.name ||
      !sameValue(draft.config, base.config) ||
      !sameValue(draft.background ?? null, base.background ?? null)
    );
  }

  #select(id: string | undefined) {
    this.selected = id;
    this.draft = undefined;
    this.issues = [];
    this.error = undefined;
    this.confirmDelete = false;
    this.editorReady = undefined;
    const instance = id === undefined ? undefined : this.state?.instances[id];
    if (instance) this.draft = this.#draftOf(instance);
  }

  #startNew() {
    this.#select("new");
  }

  #startDraft(choice: TypeChoice) {
    const schema = this.schemas?.[choice.plugin]?.types[choice.type];
    this.draft = {
      plugin: choice.plugin,
      type: choice.type,
      name: "",
      config: schema ? (initialValue(describeForm(schema)) ?? {}) : {},
    };
    this.editorReady = undefined;
  }

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
      const { id } = await send({
        type: "instance.create",
        payload: {
          plugin: draft.plugin,
          type: draft.type,
          name: draft.name.trim(),
          config: (draft.config ?? {}) as never,
          ...(draft.background !== undefined && { background: draft.background }),
        },
      });
      if (id) {
        this.#awaiting = id;
        this.#select(id);
      }
    });
  };

  #save = () => {
    const draft = this.draft;
    if (!draft?.id) return;
    const id = draft.id;
    void this.#run(async () => {
      await send({
        type: "instance.update",
        payload: {
          id,
          name: draft.name.trim(),
          config: (draft.config ?? {}) as never,
          background: draft.background ?? null,
        },
      });
      // Pick up what the server stored (with defaults), now or when its patch arrives.
      this.draft = undefined;
      this.#base = undefined;
    });
  };

  #revert = () => {
    const instance = this.draft?.id ? this.state?.instances[this.draft.id] : undefined;
    if (instance) this.draft = this.#draftOf(instance);
    this.issues = [];
    this.error = undefined;
  };

  #addToRotation = () => {
    const id = this.draft?.id;
    if (id)
      void this.#run(
        async () => void (await send({ type: "playlist.addItem", payload: { instanceId: id } })),
      );
  };

  #delete = () => {
    const id = this.draft?.id;
    if (!id) return;
    void this.#run(async () => {
      await send({ type: "instance.delete", payload: { id } });
      this.#select(undefined);
    });
  };
}

customElements.define("sb-library-page", LibraryPage);
