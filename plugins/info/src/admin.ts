// The Wi-Fi overlay's custom editor (ADR 0015): the generated form, next to a live preview of
// the QR code, so it can be scanned with a phone before the widget is placed.
import "@storbild/plugin-sdk/admin";
import type {
  EditorProperties,
  Issue,
  JsonSchema,
  ValueChangeEvent,
} from "@storbild/plugin-sdk/admin";
import { css, html, LitElement, type PropertyDeclarations } from "lit";
import type { WifiNetwork } from "./wifi.ts";
import { qrPath, wifiPayload } from "./wifi.ts";

type Value = Partial<WifiNetwork> | undefined;

class WifiEditor extends LitElement implements EditorProperties<Value> {
  static override properties: PropertyDeclarations = {
    value: { attribute: false },
    schema: { attribute: false },
    settings: { attribute: false },
    issues: { attribute: false },
  };

  static override styles = css`
    :host {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 24px;
      align-items: start;
    }
    figure {
      display: grid;
      gap: 8px;
      justify-items: center;
      margin: 0;
      padding: 12px;
      border: 1px solid var(--sb-line);
      border-radius: var(--sb-radius);
    }
    svg,
    .empty {
      width: 176px;
      height: 176px;
      background: #fff;
    }
    .empty {
      display: grid;
      place-items: center;
      background: var(--sb-bg-sunken);
      color: var(--sb-muted);
      font-size: var(--sb-text-sm);
      text-align: center;
    }
    figcaption {
      max-width: 176px;
      color: var(--sb-muted);
      font-size: var(--sb-text-xs);
      text-align: center;
    }
    @media (max-width: 640px) {
      :host {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `;

  declare value: Value;
  declare schema: JsonSchema;
  declare settings: unknown;
  declare issues: Issue[];

  #preview() {
    const ssid = this.value?.ssid;
    if (!ssid) return html`<div class="empty">Enter a network name</div>`;
    const { size, d } = qrPath(
      wifiPayload({
        ssid,
        password: this.value?.password,
        security: this.value?.security ?? "WPA",
        hidden: this.value?.hidden,
      }),
    );
    return html`<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code preview">
      <path fill="#000" d=${d}></path>
    </svg>`;
  }

  override render() {
    return html`<sb-form
        .schema=${this.schema}
        .value=${this.value}
        .issues=${this.issues ?? []}
        @change=${(e: ValueChangeEvent) => {
          e.stopPropagation();
          this.dispatchEvent(new CustomEvent("change", { detail: { value: e.detail.value } }));
        }}
      ></sb-form>
      <figure>
        ${this.#preview()}
        <figcaption>Scan with a phone to check that it joins.</figcaption>
      </figure>`;
  }
}

customElements.define("sb-info-wifi-editor", WifiEditor);
