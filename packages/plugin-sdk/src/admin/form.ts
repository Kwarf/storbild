import type { Issue } from "@storbild/core";
import { css, html, LitElement, nothing, type PropertyDeclarations } from "lit";
import { describeForm, type Field, type JsonSchema } from "../form-model.ts";
import "./field.ts";
import type { ValueChangeEvent } from "./events.ts";
import { changed } from "./shared.ts";

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

if (!customElements.get("sb-form")) customElements.define("sb-form", SbForm);

declare global {
  interface HTMLElementTagNameMap {
    "sb-form": SbForm;
  }
}
