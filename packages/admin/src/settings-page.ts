import type { Issue, ShowSettings, ShowState } from "@storbild/core";
import "@storbild/plugin-sdk/admin";
import type { Field, ValueChangeEvent } from "@storbild/plugin-sdk/admin";
import { css, html, LitElement, nothing, type PropertyDeclarations } from "lit";
import { CommandFailed, errorText, send } from "./api.ts";
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

/** The Settings page (DESIGN.md §8.2): show-wide defaults, stored in state (ADR 0010). */
export class SettingsPage extends LitElement {
  static override properties: PropertyDeclarations = {
    state: { attribute: false },
    draft: { state: true },
    issues: { state: true },
    error: { state: true },
    busy: { state: true },
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
    `,
  ];

  declare state: ShowState | undefined;
  declare draft: Partial<ShowSettings>;
  declare issues: Issue[];
  declare error: string | undefined;
  declare busy: boolean;

  constructor() {
    super();
    this.draft = {};
    this.issues = [];
    this.busy = false;
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
    `;
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
