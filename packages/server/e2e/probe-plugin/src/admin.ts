// A custom editor for the e2e tests, built from the SDK's form components (ADR 0010).
import "@storbild/plugin-sdk/admin";
import type { Issue, ValueChangeEvent } from "@storbild/plugin-sdk/admin";
import { html, LitElement, type PropertyDeclarations } from "lit";

class ProbeCardEditor extends LitElement {
  static override properties: PropertyDeclarations = {
    value: { attribute: false },
    issues: { attribute: false },
  };

  declare value: { text?: string } | undefined;
  declare issues: Issue[];

  override render() {
    return html`<p class="custom-editor">Probe card editor</p>
      <sb-field
        .field=${{ kind: "text", label: "Card text", required: true, nullable: false }}
        .value=${this.value?.text ?? ""}
        .issues=${(this.issues ?? []).filter((issue) => issue.path[0] === "text").map((issue) => ({ ...issue, path: [] }))}
        @change=${(e: ValueChangeEvent) => {
          e.stopPropagation();
          this.dispatchEvent(
            new CustomEvent("change", { detail: { value: { text: e.detail.value } } }),
          );
        }}
      ></sb-field>`;
  }
}

customElements.define("probe-card-editor", ProbeCardEditor);
