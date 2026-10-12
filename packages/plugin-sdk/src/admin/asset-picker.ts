import type { AssetMeta } from "@storbild/core";
import { css, html, LitElement, nothing, type PropertyDeclarations } from "lit";
import { ASSET_SOURCE_REQUEST, type AssetSource, type AssetSourceRequest } from "./events.ts";
import { changed, fieldStyles } from "./shared.ts";

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

if (!customElements.get("sb-asset-picker")) {
  customElements.define("sb-asset-picker", SbAssetPicker);
}

declare global {
  interface HTMLElementTagNameMap {
    "sb-asset-picker": SbAssetPicker;
  }
}
