import { formatDuration, type Issue, parseDuration } from "@storbild/core";
import { html, LitElement, nothing, type PropertyDeclarations, type PropertyValues } from "lit";
import { type Field, initialValue, parseOffset } from "../form-model.ts";
import "./asset-picker.ts";
import { CLOCK_REQUEST, type ClockRequest, type ValueChangeEvent } from "./events.ts";
import { changed, fieldStyles, issuesBelow } from "./shared.ts";

/** `datetime-local` value in local time, or "" for none. */
function toLocalInput(epochMs: unknown): string {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return "";
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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
    offset: { state: true },
  };

  static override styles = fieldStyles;

  declare field: Field | undefined;
  declare value: unknown;
  /** Validation issues with paths relative to this field. */
  declare issues: Issue[];
  /** Text being typed into a duration or JSON field, until it parses. */
  declare draft: string | undefined;
  declare draftError: string | undefined;
  /** The offset from now being typed into a date-time field; `undefined` shows the date. */
  declare offset: string | undefined;
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
    if (changes.has("field")) this.offset = undefined;
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

  /** Swaps a date-time field to its offset input, or back with `undefined`, and focuses it. */
  async #toOffset(offset: string | undefined) {
    this.offset = offset;
    this.draftError = undefined;
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLInputElement>("#input")?.focus();
  }

  /** The server time from the admin; the browser's is close enough without one. */
  #now(): number {
    const request: ClockRequest = new CustomEvent(CLOCK_REQUEST, {
      bubbles: true,
      composed: true,
      detail: {},
    });
    this.dispatchEvent(request);
    return request.detail.now?.() ?? Date.now();
  }

  /** "In h:mm": converted to now plus the offset, to the minute, back in the date input. */
  #offsetControl(field: Field) {
    const convert = () => {
      const ms = parseOffset(this.offset ?? "");
      if (ms === null || ms === undefined) {
        this.draftError = "Enter minutes, or hours and minutes as h:mm.";
        return;
      }
      this.#set(Math.round((this.#now() + ms) / 60_000) * 60_000);
      void this.#toOffset(undefined);
    };
    return html`<span class="inline">
      <input
        id="input"
        type="text"
        class="num"
        inputmode="numeric"
        placeholder="h:mm or minutes"
        aria-label="${field.label} from now"
        .value=${this.offset ?? ""}
        @input=${(e: Event) => {
          this.offset = (e.target as HTMLInputElement).value;
          this.draftError = undefined;
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter") {
            e.preventDefault();
            convert();
          } else if (e.key === "Escape") {
            e.preventDefault();
            void this.#toOffset(undefined);
          }
        }}
      />
      <button type="button" @click=${convert}>Convert</button>
      <button type="button" @click=${() => this.#toOffset(undefined)}>Cancel</button>
    </span>`;
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
        if (this.offset !== undefined) return this.#offsetControl(field);
        return html`<span class="inline">
          <input
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
          />
          <button type="button" title="Set it as a time from now" @click=${() => this.#toOffset("")}>
            In…
          </button>
        </span>`;
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
              : html`<option value="-1" ?selected=${index < 0}>${field.placeholder ?? (field.required ? "Choose…" : "None")}</option>`
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

if (!customElements.get("sb-field")) customElements.define("sb-field", SbField);

declare global {
  interface HTMLElementTagNameMap {
    "sb-field": SbField;
  }
}
