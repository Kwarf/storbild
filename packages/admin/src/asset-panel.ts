import { type AssetMeta, assetUsers, type ShowState } from "@storbild/core";
import { css, html, LitElement, nothing, type PropertyDeclarations } from "lit";
import { errorText, send } from "./api.ts";
import { formatClock } from "./format.ts";
import { controls, page } from "./styles.ts";

/** A file size for people: KB below a megabyte, else MB with one decimal. */
export function sizeText(bytes: number): string {
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * The Library's panel for an uploaded file (ADR 0011): a preview, its details, renaming, and
 * deleting it once nothing uses it.
 */
export class AssetPanel extends LitElement {
  static override properties: PropertyDeclarations = {
    state: { attribute: false },
    asset: { attribute: false },
    name: { state: true },
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
        gap: 16px;
        max-width: 760px;
        padding: 0;
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
      .preview {
        width: 100%;
        max-width: 480px;
        aspect-ratio: 16 / 9;
        display: grid;
        place-items: center;
        background: var(--sb-bg-sunken);
        border: 1px solid var(--sb-line);
        border-radius: var(--sb-radius);
        overflow: hidden;
      }
      .preview img,
      .preview video {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
      }
      dl {
        display: grid;
        grid-template-columns: max-content minmax(0, 1fr);
        gap: 4px 16px;
        margin: 0;
        font-size: var(--sb-text-sm);
      }
      dt {
        color: var(--sb-muted);
      }
      dd {
        margin: 0;
      }
      .rename {
        display: flex;
        gap: 8px;
        align-items: end;
      }
      .rename label {
        flex: 1;
        max-width: 420px;
      }
      .rename input {
        width: 100%;
        box-sizing: border-box;
      }
      .bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding-top: 12px;
        border-top: 1px solid var(--sb-line);
      }
    `,
  ];

  declare state: ShowState;
  declare asset: AssetMeta;
  /** The name being typed, until saved. */
  declare name: string | undefined;
  declare error: string | undefined;
  declare busy: boolean;
  declare confirmDelete: boolean;

  constructor() {
    super();
    this.busy = false;
    this.confirmDelete = false;
  }

  protected override willUpdate(changes: Map<string, unknown>) {
    const previous = changes.get("asset") as AssetMeta | undefined;
    if (changes.has("asset") && previous?.id !== this.asset.id) {
      this.name = undefined;
      this.error = undefined;
      this.confirmDelete = false;
    }
  }

  override render() {
    const { asset, state } = this;
    const users = assetUsers(state, asset.id);
    const name = this.name ?? asset.name;
    const image = asset.mimeType.startsWith("image/");
    const video = asset.mimeType.startsWith("video/");
    return html`
      <div class="panel-head">
        <h2>${asset.name}</h2>
        <span class="type">File</span>
      </div>
      ${
        image
          ? html`<div class="preview" aria-label="Preview">
              <img alt="" src=${`/assets/${asset.id}`} />
            </div>`
          : video
            ? html`<div class="preview" aria-label="Preview">
                <video src=${`/assets/${asset.id}`} muted loop autoplay playsinline></video>
              </div>`
            : nothing
      }
      <dl>
        <dt>Type</dt>
        <dd>${asset.mimeType}</dd>
        ${
          asset.width && asset.height
            ? html`<dt>Size</dt>
                <dd class="num">${asset.width}×${asset.height}</dd>`
            : nothing
        }
        <dt>File size</dt>
        <dd class="num">${sizeText(asset.size)}</dd>
        <dt>Uploaded</dt>
        <dd class="num">
          ${new Date(asset.createdAt).toLocaleDateString([], { day: "numeric", month: "short" })}
          ${formatClock(asset.createdAt)}
        </dd>
        <dt>Used by</dt>
        <dd>${users.length === 0 ? "Nothing" : users.map((user) => user.name).join(", ")}</dd>
      </dl>
      <div class="rename">
        <label class="field">
          Name
          <input
            type="text"
            name="asset-name"
            .value=${name}
            @input=${(e: Event) => {
              this.name = (e.target as HTMLInputElement).value;
            }}
          />
        </label>
        <button
          class="primary"
          ?disabled=${this.busy || !name.trim() || name.trim() === asset.name}
          @click=${this.#rename}
        >
          Rename
        </button>
      </div>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      <div class="bar">
        ${
          users.length > 0
            ? html`<span class="muted" style="font-size: var(--sb-text-sm)">
                In use, so it can't be deleted.
              </span>`
            : this.confirmDelete
              ? html`<span class="muted" role="status">Delete this file?</span>
                  <button class="danger" ?disabled=${this.busy} @click=${this.#delete}>Delete</button>
                  <button
                    @click=${() => {
                      this.confirmDelete = false;
                    }}
                  >
                    Keep
                  </button>`
              : html`<button
                  class="danger"
                  ?disabled=${this.busy}
                  @click=${() => {
                    this.confirmDelete = true;
                  }}
                >
                  Delete
                </button>`
        }
      </div>
    `;
  }

  async #run(work: () => Promise<unknown>) {
    this.busy = true;
    this.error = undefined;
    try {
      await work();
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.busy = false;
    }
  }

  #rename = () => {
    const name = (this.name ?? "").trim();
    void this.#run(async () => {
      await send({ type: "asset.update", payload: { id: this.asset.id, name } });
      this.name = undefined;
    });
  };

  #delete = () => {
    void this.#run(() => send({ type: "asset.delete", payload: { id: this.asset.id } }));
  };
}

customElements.define("sb-asset-panel", AssetPanel);
