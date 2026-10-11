import type { Issue, PluginEntry, ShowState } from "@storbild/core";
import "@storbild/plugin-sdk/admin";
import type { ValueChangeEvent } from "@storbild/plugin-sdk/admin";
import { css, html, LitElement, nothing, type PropertyDeclarations } from "lit";
import { CommandFailed, errorText, type Schemas, send } from "./api.ts";
import { sameValue } from "./content.ts";
import { controls, page } from "./styles.ts";

interface Edit {
  /** The stored settings the draft was made from. */
  base: unknown;
  value: unknown;
  issues: Issue[];
  error?: string | undefined;
  busy?: boolean;
  confirmRemove?: boolean;
  /** Saved; the next stored settings replace the draft. */
  saved?: boolean;
}

const statusText: Record<PluginEntry["status"], string> = {
  ok: "OK",
  error: "Error",
  incompatible: "Incompatible",
  missing: "Missing",
};

/**
 * The Plugins page (DESIGN.md §8.2): each plugin's status, version and types, a form for its
 * settings, and removal of a plugin that is no longer installed (ADR 0004).
 */
export class PluginsPage extends LitElement {
  static override properties: PropertyDeclarations = {
    state: { attribute: false },
    schemas: { attribute: false },
    edits: { state: true },
  };

  static override styles = [
    controls,
    page,
    css`
      :host {
        max-width: 880px;
      }
      section {
        padding: 16px 0;
        border-bottom: 1px solid var(--sb-line);
        display: grid;
        gap: 10px;
      }
      section:first-of-type {
        margin-top: 12px;
        border-top: 1px solid var(--sb-line);
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 10px;
      }
      .head .id {
        color: var(--sb-muted);
        font-size: var(--sb-text-sm);
      }
      .types {
        margin: 0;
        color: var(--sb-muted);
        font-size: var(--sb-text-sm);
      }
      sb-form {
        max-width: 560px;
      }
      .badge.ok {
        color: var(--sb-live);
      }
    `,
  ];

  declare state: ShowState | undefined;
  declare schemas: Schemas | undefined;
  declare edits: Record<string, Edit>;

  constructor() {
    super();
    this.edits = {};
  }

  /** Each plugin's draft settings; settings stored elsewhere or just saved replace a clean draft. */
  protected override willUpdate() {
    const plugins = this.state?.plugins ?? {};
    let edits: Record<string, Edit> | undefined;
    for (const [id, entry] of Object.entries(plugins)) {
      const edit = this.edits[id];
      if (edit?.base === entry.settings) continue;
      if (edit && !edit.saved && !sameValue(edit.value, edit.base)) continue;
      edits ??= { ...this.edits };
      edits[id] = {
        ...edit,
        base: entry.settings,
        value: structuredClone(entry.settings),
        issues: edit?.issues ?? [],
        saved: false,
      };
    }
    if (edits) this.edits = edits;
  }

  override render() {
    const state = this.state;
    if (!state) return html`<h1>Plugins</h1><p class="muted">Connecting…</p>`;
    const plugins = Object.entries(state.plugins).sort(([a], [b]) => a.localeCompare(b));
    return html`
      <h1>Plugins</h1>
      <p class="hint">Plugins are installed on the server. Their settings apply to all their instances.</p>
      ${
        plugins.length === 0
          ? html`<p class="muted">No plugins are installed.</p>`
          : plugins.map(([id, entry]) => this.#plugin(state, id, entry))
      }
    `;
  }

  #plugin(state: ShowState, id: string, entry: PluginEntry) {
    const types = Object.values(entry.types);
    const instances = Object.values(state.instances).filter((instance) => instance.plugin === id);
    const schema = this.schemas?.[id]?.settings;
    const edit = this.edits[id] ?? { base: entry.settings, value: entry.settings, issues: [] };
    const dirty = !sameValue(edit.value, edit.base);
    const statusClass = entry.status === "ok" ? "ok" : "error";
    return html`<section data-plugin=${id}>
      <div class="head">
        <h2>${id}</h2>
        ${entry.version ? html`<span class="id num">${entry.version}</span>` : nothing}
        <span class="badge ${statusClass}">${statusText[entry.status]}</span>
        <span class="id">${instances.length} instance${instances.length === 1 ? "" : "s"}</span>
      </div>
      ${entry.error ? html`<p class="notice">${entry.error}</p>` : nothing}
      ${
        entry.status === "missing"
          ? html`<p class="notice info">
              This plugin is no longer installed. Its settings and instances are kept until it is
              reinstalled or removed.
            </p>`
          : nothing
      }
      ${
        types.length > 0
          ? html`<p class="types">
              ${types.map((type) => `${type.label} (${type.kind})`).join(" · ")}
            </p>`
          : nothing
      }
      ${
        schema && entry.status !== "missing"
          ? html`<sb-form
                .schema=${schema}
                .value=${edit.value}
                .issues=${edit.issues}
                @change=${(e: ValueChangeEvent) => {
                  e.stopPropagation();
                  this.#patch(id, { value: e.detail.value });
                }}
              ></sb-form>
              <div class="actions">
                <button
                  class="primary"
                  ?disabled=${!dirty || edit.busy}
                  @click=${() => this.#save(id, edit)}
                >
                  Save settings
                </button>
                <button
                  ?disabled=${!dirty || edit.busy}
                  @click=${() => this.#patch(id, { value: structuredClone(edit.base), issues: [] })}
                >
                  Revert
                </button>
              </div>`
          : nothing
      }
      ${entry.status === "missing" ? this.#remove(id, edit, instances.length) : nothing}
      ${edit.error ? html`<p class="error" role="alert">${edit.error}</p>` : nothing}
    </section>`;
  }

  #remove(id: string, edit: Edit, count: number) {
    if (!edit.confirmRemove) {
      return html`<div class="actions">
        <button class="danger" @click=${() => this.#patch(id, { confirmRemove: true })}>Remove plugin data</button>
      </div>`;
    }
    return html`<div class="actions">
      <span class="muted" role="status"
        >Delete its settings${count > 0 ? ` and ${count} instance${count === 1 ? "" : "s"}` : ""} for good?</span
      >
      <button class="danger" ?disabled=${edit.busy} @click=${() => this.#run(id, () => send({ type: "plugin.remove", payload: { plugin: id } }))}>
        Remove
      </button>
      <button @click=${() => this.#patch(id, { confirmRemove: false })}>Keep</button>
    </div>`;
  }

  #patch(id: string, changes: Partial<Edit>) {
    const edit = this.edits[id] ?? { base: undefined, value: undefined, issues: [] };
    this.edits = { ...this.edits, [id]: { ...edit, ...changes } };
  }

  #save(id: string, edit: Edit) {
    void this.#run(id, () =>
      send({
        type: "plugin.updateSettings",
        payload: { plugin: id, settings: (edit.value ?? {}) as never },
      }),
    );
  }

  async #run(id: string, action: () => Promise<unknown>) {
    this.#patch(id, { busy: true, error: undefined, issues: [] });
    try {
      await action();
      this.#patch(id, { busy: false, saved: true });
    } catch (error) {
      this.#patch(id, {
        busy: false,
        error: errorText(error),
        issues: error instanceof CommandFailed ? error.issues : [],
      });
    }
  }
}

customElements.define("sb-plugins-page", PluginsPage);
