import type { Issue, ShowSettings, ShowState } from "@storbild/core";
import "@storbild/plugin-sdk/admin";
import type { Field, ValueChangeEvent } from "@storbild/plugin-sdk/admin";
import { css, html, LitElement, nothing, type PropertyDeclarations } from "lit";
import { CommandFailed, errorText, ImportFailed, importShow, send, showExportUrl } from "./api.ts";
import { sizeText } from "./asset-panel.ts";
import "./hold-button.ts";
import { controls, page } from "./styles.ts";

const fields: { key: keyof ShowSettings; field: Field }[] = [
  {
    key: "defaultDurationMs",
    field: {
      kind: "duration",
      label: "Default duration",
      description:
        "How long a rotation item runs when neither the item nor its type sets a duration.",
      required: true,
      nullable: false,
    },
  },
  {
    key: "transitionMs",
    field: {
      kind: "number",
      integer: true,
      minimum: 0,
      maximum: 10_000,
      label: "Transition length (ms)",
      description: "The crossfade between scenes on every screen. 0 switches at once.",
      required: true,
      nullable: false,
    },
  },
];

/**
 * The Settings page (DESIGN.md §8.2): show-wide defaults, stored in state (ADR 0010), and the
 * show file, which exports the show or replaces it with an exported one (ADR 0019).
 */
export class SettingsPage extends LitElement {
  static override properties: PropertyDeclarations = {
    state: { attribute: false },
    draft: { state: true },
    issues: { state: true },
    error: { state: true },
    busy: { state: true },
    importFile: { state: true },
    importing: { state: true },
    importError: { state: true },
    importDetails: { state: true },
    imported: { state: true },
  };

  static override styles = [
    controls,
    page,
    css`
      :host {
        max-width: 640px;
      }
      .fields {
        display: grid;
        gap: 18px;
        padding: 16px 0;
        margin-top: 12px;
        border-top: 1px solid var(--sb-line);
        border-bottom: 1px solid var(--sb-line);
      }
      sb-field {
        max-width: 320px;
      }
      .actions {
        margin-top: 16px;
      }
      section.show-file {
        margin-top: 32px;
      }
      .rows {
        margin-top: 12px;
        border-top: 1px solid var(--sb-line);
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 12px;
        padding: 10px 0;
        border-bottom: 1px solid var(--sb-line);
      }
      .row .label {
        width: 72px;
        font-weight: var(--sb-weight-strong);
        font-size: var(--sb-text-sm);
      }
      .row .muted {
        font-size: var(--sb-text-sm);
      }
      a.button {
        display: inline-flex;
        align-items: center;
        padding: 6px 12px;
        font-weight: var(--sb-weight-strong);
        font-size: var(--sb-text-sm);
        color: inherit;
        text-decoration: none;
        background: var(--sb-field);
        border: 1px solid var(--sb-line-strong);
        border-radius: var(--sb-radius);
      }
      a.button:hover {
        border-color: var(--sb-text);
      }
      input[type="file"] {
        font-size: var(--sb-text-sm);
        max-width: 320px;
      }
      input[type="file"]::file-selector-button {
        margin-right: 10px;
        padding: 6px 12px;
        font: inherit;
        font-weight: var(--sb-weight-strong);
        color: inherit;
        background: var(--sb-field);
        border: 1px solid var(--sb-line-strong);
        border-radius: var(--sb-radius);
        cursor: pointer;
      }
      input[type="file"]::file-selector-button:hover {
        border-color: var(--sb-text);
      }
      .notice {
        margin-top: 12px;
      }
      ul.details {
        margin: 6px 0 0;
        padding-left: 18px;
      }
    `,
  ];

  declare state: ShowState | undefined;
  declare draft: Partial<ShowSettings>;
  declare issues: Issue[];
  declare error: string | undefined;
  declare busy: boolean;
  declare importFile: File | undefined;
  declare importing: boolean;
  declare importError: string | undefined;
  declare importDetails: string[];
  declare imported: { missingPlugins: string[] } | undefined;

  constructor() {
    super();
    this.draft = {};
    this.issues = [];
    this.busy = false;
    this.importing = false;
    this.importDetails = [];
  }

  override render() {
    const settings = this.state?.settings;
    if (!settings) return html`<h1>Settings</h1><p class="muted">Connecting…</p>`;
    const value = { ...settings, ...this.draft };
    const dirty = fields.some(({ key }) => value[key] !== settings[key]);
    return html`
      <h1>Settings</h1>
      <p class="hint">Defaults for the whole show. Changes apply to every screen right away.</p>
      <div class="fields">
        ${fields.map(
          ({ key, field }) => html`<sb-field
            data-setting=${key}
            .field=${field}
            .value=${value[key]}
            .issues=${this.issues
              .filter((issue) => issue.path[0] === key)
              .map((issue) => ({ ...issue, path: issue.path.slice(1) }))}
            @change=${(e: ValueChangeEvent) => {
              this.draft = { ...this.draft, [key]: e.detail.value };
            }}
          ></sb-field>`,
        )}
      </div>
      <div class="actions">
        <button class="primary" ?disabled=${!dirty || this.busy} @click=${() => this.#save(value)}>
          Save
        </button>
        <button
          ?disabled=${!dirty || this.busy}
          @click=${() => {
            this.draft = {};
            this.issues = [];
            this.error = undefined;
          }}
        >
          Revert
        </button>
      </div>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      ${this.#renderShowFile()}
    `;
  }

  #renderShowFile() {
    const file = this.importFile;
    return html`
      <section class="show-file">
        <h2>Show file</h2>
        <p class="hint">
          The whole show and its files in one .zip, to prepare a show ahead of the party or move
          it to another Storbild.
        </p>
        <div class="rows">
          <div class="row">
            <span class="label">Export</span>
            <a class="button" href=${showExportUrl()} download>Download show file</a>
            <span class="muted">Everything but what is on air right now.</span>
          </div>
          <div class="row">
            <span class="label">Import</span>
            <input
              type="file"
              accept=".zip,application/zip"
              ?disabled=${this.importing}
              @change=${(e: Event) => {
                const input = e.target as HTMLInputElement;
                this.importFile = input.files?.[0];
                this.importError = undefined;
                this.importDetails = [];
                this.imported = undefined;
              }}
            />
            ${
              file
                ? html`<span class="muted num">${sizeText(file.size)}</span>
                    <sb-hold-button
                      hold-ms="1500"
                      ?disabled=${this.importing}
                      @activate=${() => this.#import(file)}
                      >${this.importing ? "Importing…" : "Hold to replace the show"}</sb-hold-button
                    >`
                : nothing
            }
          </div>
        </div>
        <p class="notice info">
          Importing replaces everything: content, rotation, schedule, overlays, themes, settings
          and files. Download the current show file first if you may need it again.
        </p>
        ${
          this.importError
            ? html`<div class="notice" role="alert">
                ${this.importError}
                ${
                  this.importDetails.length
                    ? html`<ul class="details">
                        ${this.importDetails.slice(0, 8).map((detail) => html`<li>${detail}</li>`)}
                      </ul>`
                    : nothing
                }
              </div>`
            : nothing
        }
        ${
          this.imported
            ? html`<p class="notice info" role="status">
                The show was imported.
                ${
                  this.imported.missingPlugins.length
                    ? html`This Storbild lacks the plugins
                        <strong>${this.imported.missingPlugins.join(", ")}</strong>; their
                        instances are kept in the Library but can't be shown.`
                    : nothing
                }
              </p>`
            : nothing
        }
      </section>
    `;
  }

  async #import(file: File) {
    this.importing = true;
    this.importError = undefined;
    this.importDetails = [];
    this.imported = undefined;
    try {
      this.imported = await importShow(file);
      this.importFile = undefined;
      const input = this.renderRoot.querySelector<HTMLInputElement>('input[type="file"]');
      if (input) input.value = "";
    } catch (error) {
      this.importError = errorText(error);
      if (error instanceof ImportFailed) this.importDetails = error.details;
    } finally {
      this.importing = false;
    }
  }

  async #save(value: Partial<ShowSettings>) {
    const payload: Partial<ShowSettings> = {};
    for (const { key } of fields) {
      const v = value[key];
      if (typeof v !== "number") {
        this.error = "Fill in every setting.";
        return;
      }
      payload[key] = v;
    }
    this.busy = true;
    this.error = undefined;
    this.issues = [];
    try {
      await send({ type: "settings.update", payload });
      this.draft = {};
    } catch (error) {
      this.error = errorText(error);
      if (error instanceof CommandFailed) this.issues = error.issues;
    } finally {
      this.busy = false;
    }
  }
}

customElements.define("sb-settings-page", SettingsPage);
