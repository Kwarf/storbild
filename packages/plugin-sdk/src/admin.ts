// Browser-only admin part of the SDK (DESIGN.md §6.2, ADR 0010): the form components the
// admin generates plugin forms from, which custom editors use too so they look native.
// Styled with the admin's `--sb-*` tokens, which inherit through shadow DOM.
import { type AssetMeta, formatDuration, type Issue, parseDuration } from "@storbild/core";
import {
  css,
  html,
  LitElement,
  nothing,
  type PropertyDeclarations,
  type PropertyValues,
} from "lit";
import { describeForm, type Field, initialValue, type JsonSchema } from "./form-model.ts";

export type { AssetMeta, Issue } from "@storbild/core";
export {
  describeForm,
  type Field,
  type FieldKind,
  humanize,
  initialValue,
  type JsonSchema,
} from "./form-model.ts";

/** Fired by `<sb-field>` and `<sb-form>` with the whole new value; `undefined` means left out. */
export type ValueChangeEvent = CustomEvent<{ value: unknown }>;

/**
 * What the admin sets on a plugin's custom editor element (the type's `editor`), which lives in
 * the plugin's `storbild.admin` module. The editor fires a `change` `ValueChangeEvent` with the
 * whole config on every edit; the admin validates it on the server when it is saved.
 */
export interface EditorProperties<Config = unknown, Settings = unknown> {
  value: Config;
  /** The config's JSON Schema, for editors that render parts of it with `<sb-form>`. */
  schema: JsonSchema;
  /** The plugin's current settings. */
  settings: Settings;
  /** Validation issues from the last save, with paths into the config. */
  issues: Issue[];
}

/**
 * The show's uploaded files, as the admin offers them to asset fields. The admin answers an
 * `AssetSourceRequest` with one; a custom editor never needs to, as `<sb-field>` asks itself.
 */
export interface AssetSource {
  /** The show's assets. */
  list(): AssetMeta[];
  /** The asset's file. */
  url(id: string): string;
  /** A small image for a list: the thumbnail, or the file itself when there is none. */
  previewUrl(id: string): string;
  /** Uploads a file and resolves to its asset, or rejects with a message to show. */
  upload(file: File): Promise<AssetMeta>;
  /** Calls `callback` when the assets change. Returns a function that stops it. */
  subscribe(callback: () => void): () => void;
}

/**
 * Fired (bubbling, composed) by an asset picker when it connects. The admin sets
 * `detail.source`.
 */
export type AssetSourceRequest = CustomEvent<{ source?: AssetSource }>;
export const ASSET_SOURCE_REQUEST = "sb-asset-source";

/** A file's thumbnail, or its format in letters when it has no picture, like a font. */
function thumb(source: AssetSource, asset: AssetMeta) {
  if (asset.thumbnail || asset.mimeType.startsWith("image/")) {
    return html`<img class="thumb" alt="" loading="lazy" src=${source.previewUrl(asset.id)} />`;
  }
  const format = asset.mimeType.split("/")[1] ?? "";
  return html`<span class="thumb" aria-hidden="true">${format.toUpperCase()}</span>`;
}

/** Whether a MIME type matches `accept` patterns like `image/*`; no patterns match all. */
export function accepts(accept: readonly string[] | undefined, mimeType: string): boolean {
  if (!accept || accept.length === 0) return true;
  return accept.some((pattern) =>
    pattern.endsWith("/*") ? mimeType.startsWith(pattern.slice(0, -1)) : pattern === mimeType,
  );
}

const changed = (target: EventTarget, value: unknown) =>
  target.dispatchEvent(new CustomEvent("change", { detail: { value } }));

const issuesBelow = (issues: Issue[], key: string | number) =>
  issues
    .filter((issue) => issue.path[0] === key)
    .map((issue) => ({ ...issue, path: issue.path.slice(1) }));

/** `datetime-local` value in local time, or "" for none. */
function toLocalInput(epochMs: unknown): string {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return "";
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const fieldStyles = css`
  :host {
    display: block;
    color: var(--sb-text, inherit);
    font-size: var(--sb-text-md, 15px);
  }
  input,
  select,
  textarea,
  button {
    font: inherit;
    color: inherit;
  }
  input:not([type="checkbox"]):not([type="color"]),
  select,
  textarea {
    box-sizing: border-box;
    width: 100%;
    padding: 5px 8px;
    background: var(--sb-field, #fff);
    border: 1px solid var(--sb-line-strong, #c4bfb5);
    border-radius: var(--sb-radius, 3px);
    min-width: 0;
  }
  textarea {
    resize: vertical;
    line-height: 1.45;
  }
  textarea.code {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: var(--sb-text-sm, 13px);
  }
  input[type="checkbox"] {
    accent-color: var(--sb-accent, #145f8a);
    margin: 0;
  }
  input[type="color"] {
    width: 36px;
    height: 30px;
    padding: 2px;
    background: var(--sb-field, #fff);
    border: 1px solid var(--sb-line-strong, #c4bfb5);
    border-radius: var(--sb-radius, 3px);
    flex: none;
  }
  input[type="number"],
  .num {
    font-variant-numeric: tabular-nums;
  }
  :focus-visible {
    outline: 2px solid var(--sb-accent, #145f8a);
    outline-offset: 1px;
  }
  button {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    font-size: var(--sb-text-sm, 13px);
    font-weight: var(--sb-weight-strong, 600);
    background: var(--sb-field, #fff);
    border: 1px solid var(--sb-line-strong, #c4bfb5);
    border-radius: var(--sb-radius, 3px);
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    border-color: var(--sb-text, #1c1a17);
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .field {
    display: grid;
    gap: 4px;
  }
  .head {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  label,
  .label {
    font-size: var(--sb-text-sm, 13px);
    font-weight: var(--sb-weight-strong, 600);
  }
  .optional,
  .description {
    color: var(--sb-muted, #67625a);
    font-size: var(--sb-text-xs, 12px);
    font-weight: var(--sb-weight, 400);
  }
  .description {
    margin: 0;
  }
  .check {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .inline {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .error {
    margin: 0;
    color: var(--sb-error, #b3261e);
    font-size: var(--sb-text-sm, 13px);
  }
  .group {
    display: grid;
    gap: 14px;
  }
  .nested {
    padding-left: 12px;
    border-left: 1px solid var(--sb-line, #dedad2);
  }
  .list {
    display: grid;
    gap: 0;
    border-top: 1px solid var(--sb-line, #dedad2);
  }
  .item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--sb-line, #dedad2);
  }
  .item .actions {
    display: flex;
    gap: 4px;
    align-items: flex-start;
  }
  .add {
    justify-self: start;
    margin-top: 8px;
  }
`;

/**
 * One form field of any kind, described by `field` (see `describeForm`). Objects and lists
 * render their children as nested `<sb-field>`s. Fires `change` with the new value.
 */
export class SbField extends LitElement {
  static override properties: PropertyDeclarations = {
    field: { attribute: false },
    value: { attribute: false },
    issues: { attribute: false },
    draft: { state: true },
    draftError: { state: true },
  };

  static override styles = fieldStyles;

  declare field: Field | undefined;
  declare value: unknown;
  /** Validation issues with paths relative to this field. */
  declare issues: Issue[];
  /** Text being typed into a duration or JSON field, until it parses. */
  declare draft: string | undefined;
  declare draftError: string | undefined;
  /** The value last parsed from the draft; the parent passing it back keeps the draft. */
  #emitted: unknown;

  constructor() {
    super();
    this.issues = [];
  }

  protected override willUpdate(changes: PropertyValues<this>) {
    // A new value from outside replaces whatever was being typed.
    const echo = changes.has("value") && Object.is(this.value, this.#emitted);
    if ((changes.has("value") && !echo) || changes.has("field")) {
      this.draft = undefined;
      this.draftError = undefined;
    }
  }

  /** Reports a value parsed from the draft, without replacing the draft. */
  #emit(value: unknown) {
    this.#emitted = value;
    changed(this, value);
  }

  override render() {
    const field = this.field;
    if (!field) return nothing;
    if (field.kind === "object") return this.#object(field, this.value);
    const own = this.issues
      .filter((issue) => issue.path.length === 0)
      .map((issue) => issue.message);
    const error = this.draftError ?? own[0];
    if (field.kind === "boolean") {
      return html`<div class="field">
        <span class="check">
          <input
            id="input"
            type="checkbox"
            .checked=${this.value === true}
            @change=${(e: Event) => this.#set((e.target as HTMLInputElement).checked)}
          />
          <label for="input">${field.label}</label>
        </span>
        ${this.#description(field)} ${error ? html`<p class="error" role="alert">${error}</p>` : nothing}
      </div>`;
    }
    return html`<div class="field">
      ${
        field.label
          ? html`<span class="head"
              ><label for="input">${field.label}</label>${
                field.required ? nothing : html`<span class="optional">optional</span>`
              }</span
            >`
          : nothing
      }
      ${this.#description(field)} ${this.#control(field)}
      ${error ? html`<p class="error" role="alert">${error}</p>` : nothing}
    </div>`;
  }

  #description(field: Field) {
    return field.description ? html`<p class="description">${field.description}</p>` : nothing;
  }

  /** Blank input: left out when optional, `null` when nullable, else the empty string. */
  #blank(field: Field) {
    if (!field.required) return undefined;
    return field.nullable ? null : "";
  }

  #set(value: unknown) {
    this.value = value;
    changed(this, value);
  }

  #control(field: Field) {
    const value = this.value;
    const text = (e: Event) => (e.target as HTMLInputElement | HTMLTextAreaElement).value;
    switch (field.kind) {
      case "text":
        return html`<input
          id="input"
          type="text"
          placeholder=${field.placeholder ?? nothing}
          .value=${typeof value === "string" ? value : ""}
          @input=${(e: Event) => this.#set(text(e) === "" ? this.#blank(field) : text(e))}
        />`;
      case "markdown":
        return html`<textarea
          id="input"
          rows="8"
          placeholder=${field.placeholder ?? nothing}
          .value=${typeof value === "string" ? value : ""}
          @input=${(e: Event) => this.#set(text(e) === "" ? this.#blank(field) : text(e))}
        ></textarea>`;
      case "color": {
        const hex = typeof value === "string" ? value : "";
        return html`<span class="inline">
          <input
            type="color"
            aria-label="${field.label} picker"
            .value=${/^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#000000"}
            @input=${(e: Event) => this.#set(text(e))}
          />
          <input
            id="input"
            type="text"
            class="num"
            placeholder="#rrggbb"
            .value=${hex}
            @input=${(e: Event) => this.#set(text(e) === "" ? this.#blank(field) : text(e))}
          />
        </span>`;
      }
      case "number":
        return html`<input
          id="input"
          type="number"
          placeholder=${field.placeholder ?? nothing}
          step=${field.integer ? "1" : "any"}
          min=${field.minimum ?? nothing}
          max=${field.maximum ?? nothing}
          .value=${typeof value === "number" ? String(value) : ""}
          @input=${(e: Event) => {
            const input = e.target as HTMLInputElement;
            if (input.value === "") this.#set(field.nullable ? null : undefined);
            else if (Number.isFinite(input.valueAsNumber)) this.#set(input.valueAsNumber);
          }}
        />`;
      case "duration":
        return html`<input
          id="input"
          type="text"
          class="num"
          placeholder=${field.placeholder ?? "seconds or m:ss"}
          .value=${this.draft ?? (typeof value === "number" ? formatDuration(value) : "")}
          @input=${(e: Event) => {
            this.draft = text(e);
            const ms = parseDuration(this.draft);
            this.draftError = ms === null ? "Enter seconds or m:ss." : undefined;
            if (ms !== null) this.#emit(ms ?? (field.nullable ? null : undefined));
          }}
        />`;
      case "datetime":
        return html`<input
          id="input"
          type="datetime-local"
          class="num"
          .value=${toLocalInput(value)}
          @change=${(e: Event) => {
            const input = text(e);
            this.#set(
              input === "" ? (field.nullable ? null : undefined) : new Date(input).getTime(),
            );
          }}
        />`;
      case "select": {
        const index = field.options.findIndex((option) => Object.is(option.value, value));
        return html`<select
          id="input"
          @change=${(e: Event) => {
            const i = Number((e.target as HTMLSelectElement).value);
            this.#set(i < 0 ? (field.nullable ? null : undefined) : field.options[i]?.value);
          }}
        >
          ${
            field.required && index >= 0
              ? nothing
              : html`<option value="-1" ?selected=${index < 0}>${field.required ? "Choose…" : "None"}</option>`
          }
          ${field.options.map(
            (option, i) =>
              html`<option value=${i} ?selected=${i === index}>${option.label}</option>`,
          )}
        </select>`;
      }
      case "asset":
        return html`<sb-asset-picker
          .value=${typeof value === "string" && value !== "" ? value : undefined}
          .accept=${field.accept}
          .label=${field.label}
          .optional=${!field.required || field.nullable}
          @change=${(e: ValueChangeEvent) => {
            e.stopPropagation();
            this.#set(e.detail.value ?? this.#blank(field));
          }}
        ></sb-asset-picker>`;
      case "list":
        return this.#list(field, Array.isArray(value) ? value : []);
      case "json":
        return html`<textarea
          id="input"
          class="code"
          rows="5"
          .value=${this.draft ?? (value === undefined ? "" : JSON.stringify(value, null, 2))}
          @input=${(e: Event) => {
            this.draft = text(e);
            if (this.draft.trim() === "") {
              this.draftError = undefined;
              this.#emit(this.#blank(field) === "" ? undefined : this.#blank(field));
              return;
            }
            try {
              const parsed: unknown = JSON.parse(this.draft);
              this.draftError = undefined;
              this.#emit(parsed);
            } catch {
              this.draftError = "Not valid JSON.";
            }
          }}
        ></textarea>`;
      default:
        return nothing;
    }
  }

  #object(field: Extract<Field, { kind: "object" }>, value: unknown) {
    const object = (typeof value === "object" && value !== null ? value : {}) as Record<
      string,
      unknown
    >;
    const own = this.issues.filter((issue) => issue.path.length === 0);
    const body = html`<div class="group">
      ${field.properties.map(
        ({ key, field: child }) => html`<sb-field
          data-key=${key}
          .field=${child}
          .value=${object[key]}
          .issues=${issuesBelow(this.issues, key)}
          @change=${(e: ValueChangeEvent) => {
            e.stopPropagation();
            const next = { ...object };
            if (e.detail.value === undefined) delete next[key];
            else next[key] = e.detail.value;
            this.#set(next);
          }}
        ></sb-field>`,
      )}
      ${own.map((issue) => html`<p class="error" role="alert">${issue.message}</p>`)}
    </div>`;
    if (!field.label) return body;
    return html`<div class="field">
      <span class="head"><span class="label">${field.label}</span></span>
      ${this.#description(field)}
      <div class="nested">${body}</div>
    </div>`;
  }

  #list(field: Extract<Field, { kind: "list" }>, items: unknown[]) {
    const update = (next: unknown[]) => this.#set(next);
    const move = (from: number, to: number) => {
      const next = [...items];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      update(next);
    };
    const full = field.maxItems !== undefined && items.length >= field.maxItems;
    const atMin = field.minItems !== undefined && items.length <= field.minItems;
    return html`<div class="list" id="input" role="list">
        ${items.map(
          (item, i) => html`<div class="item" role="listitem">
            <sb-field
              .field=${{ ...field.items, label: field.items.kind === "object" ? "" : `${field.items.label} ${i + 1}` }}
              .value=${item}
              .issues=${issuesBelow(this.issues, i)}
              @change=${(e: ValueChangeEvent) => {
                e.stopPropagation();
                update(items.map((old, j) => (j === i ? e.detail.value : old)));
              }}
            ></sb-field>
            <span class="actions">
              <button aria-label="Move up" title="Move up" ?disabled=${i === 0} @click=${() => move(i, i - 1)}>↑</button>
              <button
                aria-label="Move down"
                title="Move down"
                ?disabled=${i === items.length - 1}
                @click=${() => move(i, i + 1)}
              >
                ↓
              </button>
              <button ?disabled=${atMin} @click=${() => update(items.filter((_, j) => j !== i))}>Remove</button>
            </span>
          </div>`,
        )}
      </div>
      <button class="add" ?disabled=${full} @click=${() => update([...items, initialValue(field.items)])}>
        Add
      </button>`;
  }
}

const sizeText = (asset: AssetMeta) => {
  const kb = asset.size / 1024;
  const size = kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
  return asset.width && asset.height ? `${asset.width}×${asset.height} · ${size}` : size;
};

/**
 * Picks an uploaded file, or uploads a new one, for an asset field. Its value is an asset ID;
 * it fires `change` with the new ID, or `undefined` when cleared. The assets come from the
 * admin through an `AssetSourceRequest`; without a source it shows the ID read-only.
 */
export class SbAssetPicker extends LitElement {
  static override properties: PropertyDeclarations = {
    value: { attribute: false },
    accept: { attribute: false },
    label: { attribute: false },
    optional: { attribute: false },
    open: { state: true },
    busy: { state: true },
    error: { state: true },
  };

  static override styles = [
    fieldStyles,
    css`
      .current {
        display: flex;
        gap: 10px;
        align-items: center;
        min-height: 40px;
      }
      .thumb {
        flex: none;
        box-sizing: border-box;
        width: 56px;
        height: 40px;
        object-fit: contain;
        background: var(--sb-bg-sunken, #efece6);
        border: 1px solid var(--sb-line, #dedad2);
        border-radius: var(--sb-radius, 3px);
      }
      span.thumb {
        display: grid;
        place-items: center;
        font-size: var(--sb-text-xs, 11px);
        letter-spacing: 0.06em;
        color: var(--sb-muted, #6b675f);
      }
      .what {
        display: grid;
        min-width: 0;
        flex: 1;
      }
      .name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .meta {
        color: var(--sb-muted, #67625a);
        font-size: var(--sb-text-xs, 12px);
        font-variant-numeric: tabular-nums;
      }
      .choices {
        margin: 8px 0 0;
        padding: 0;
        list-style: none;
        max-height: 280px;
        overflow-y: auto;
        border-top: 1px solid var(--sb-line, #dedad2);
      }
      .choices li {
        border-bottom: 1px solid var(--sb-line, #dedad2);
      }
      .choices button {
        display: flex;
        gap: 10px;
        width: 100%;
        padding: 4px 6px;
        text-align: left;
        font-weight: var(--sb-weight, 400);
        background: none;
        border: 0;
        border-radius: 0;
      }
      .choices button:hover,
      .choices button[aria-pressed="true"] {
        background: var(--sb-bg-sunken, #efece6);
      }
      .empty {
        margin: 8px 0 0;
        color: var(--sb-muted, #67625a);
        font-size: var(--sb-text-sm, 13px);
      }
      input[type="file"] {
        display: none;
      }
    `,
  ];

  declare value: string | undefined;
  declare accept: string[] | undefined;
  declare label: string;
  declare optional: boolean;
  declare open: boolean;
  declare busy: boolean;
  declare error: string | undefined;
  #source: AssetSource | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor() {
    super();
    this.label = "File";
    this.optional = false;
    this.open = false;
    this.busy = false;
  }

  override connectedCallback() {
    super.connectedCallback();
    const request: AssetSourceRequest = new CustomEvent(ASSET_SOURCE_REQUEST, {
      bubbles: true,
      composed: true,
      detail: {},
    });
    this.dispatchEvent(request);
    this.#source = request.detail.source;
    this.#unsubscribe = this.#source?.subscribe(() => this.requestUpdate());
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  #pick(id: string | undefined) {
    this.value = id;
    this.open = false;
    changed(this, id);
  }

  async #upload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !this.#source) return;
    this.busy = true;
    this.error = undefined;
    try {
      this.#pick((await this.#source.upload(file)).id);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }

  override render() {
    const source = this.#source;
    if (!source) {
      return html`<input id="input" type="text" class="num" readonly .value=${this.value ?? ""} />`;
    }
    const assets = source.list();
    const current = assets.find((asset) => asset.id === this.value);
    const choices = assets
      .filter((asset) => accepts(this.accept, asset.mimeType))
      .sort((a, b) => b.createdAt - a.createdAt);
    return html`<div class="current">
        ${
          current
            ? html`${thumb(source, current)}
                <span class="what">
                  <span class="name">${current.name}</span>
                  <span class="meta">${sizeText(current)}</span>
                </span>`
            : html`<span class="what">
                <span class="meta">${this.value ? "This file is no longer available." : "No file chosen."}</span>
              </span>`
        }
        <button
          id="input"
          aria-expanded=${this.open ? "true" : "false"}
          aria-label="Choose ${this.label}"
          @click=${() => {
            this.open = !this.open;
          }}
        >
          Choose…
        </button>
        <button ?disabled=${this.busy} @click=${() => this.renderRoot.querySelector("input")?.click()}>
          ${this.busy ? "Uploading…" : "Upload…"}
        </button>
        ${
          this.optional && this.value
            ? html`<button @click=${() => this.#pick(undefined)}>Clear</button>`
            : nothing
        }
        <input
          type="file"
          aria-label="Upload ${this.label}"
          accept=${this.accept?.join(",") ?? nothing}
          @change=${(e: Event) => this.#upload(e)}
        />
      </div>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      ${
        !this.open
          ? nothing
          : choices.length === 0
            ? html`<p class="empty">Nothing uploaded yet that fits here.</p>`
            : html`<ul class="choices" aria-label="Files">
                ${choices.map(
                  (asset) => html`<li>
                    <button
                      aria-pressed=${asset.id === this.value ? "true" : "false"}
                      @click=${() => this.#pick(asset.id)}
                    >
                      ${thumb(source, asset)}
                      <span class="what">
                        <span class="name">${asset.name}</span>
                        <span class="meta">${sizeText(asset)}</span>
                      </span>
                    </button>
                  </li>`,
                )}
              </ul>`
      }`;
  }
}

/**
 * A whole generated form for a JSON Schema (a plugin's config or settings). Fires `change`
 * with the new value on every edit.
 */
export class SbForm extends LitElement {
  static override properties: PropertyDeclarations = {
    schema: { attribute: false },
    value: { attribute: false },
    issues: { attribute: false },
  };

  static override styles = css`
    :host {
      display: block;
    }
  `;

  declare schema: JsonSchema | undefined;
  declare value: unknown;
  declare issues: Issue[];
  #field: Field | undefined;
  #fieldOf: JsonSchema | undefined;

  constructor() {
    super();
    this.issues = [];
  }

  override render() {
    if (!this.schema) return nothing;
    if (this.#fieldOf !== this.schema) {
      this.#fieldOf = this.schema;
      this.#field = describeForm(this.schema);
    }
    return html`<sb-field
      .field=${this.#field}
      .value=${this.value}
      .issues=${this.issues}
      @change=${(e: ValueChangeEvent) => {
        e.stopPropagation();
        this.value = e.detail.value;
        changed(this, e.detail.value);
      }}
    ></sb-field>`;
  }
}

if (!customElements.get("sb-field")) customElements.define("sb-field", SbField);
if (!customElements.get("sb-form")) customElements.define("sb-form", SbForm);
if (!customElements.get("sb-asset-picker")) {
  customElements.define("sb-asset-picker", SbAssetPicker);
}

declare global {
  interface HTMLElementTagNameMap {
    "sb-field": SbField;
    "sb-form": SbForm;
    "sb-asset-picker": SbAssetPicker;
  }
}
