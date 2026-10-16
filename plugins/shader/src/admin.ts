// The shader's custom editor (ADR 0031): the source in a plain text field, opened from a file
// or pasted, checked by compiling it here the way the screens do, with the other fields below.
import "@storbild/plugin-sdk/admin";
import type {
  EditorProperties,
  Issue,
  JsonSchema,
  ValueChangeEvent,
} from "@storbild/plugin-sdk/admin";
import { css, html, LitElement, nothing, type PropertyDeclarations } from "lit";
import { check, type Diagnostic } from "./glsl.ts";
import { compile } from "./webgl.ts";

type Value = Record<string, unknown> | undefined;

/** How long typing must pause before the source is checked. */
const CHECK_DELAY_MS = 300;

type Status =
  | { kind: "checking" }
  | { kind: "unavailable" }
  | { kind: "done"; diagnostics: Diagnostic[] };

class ShaderEditor extends LitElement implements EditorProperties<Value> {
  static override properties: PropertyDeclarations = {
    value: { attribute: false },
    schema: { attribute: false },
    settings: { attribute: false },
    issues: { attribute: false },
    status: { state: true },
  };

  static override styles = css`
    :host {
      display: grid;
      gap: 14px;
      font-size: var(--sb-text-md, 15px);
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
    label {
      font-size: var(--sb-text-sm, 13px);
      font-weight: var(--sb-weight-strong, 600);
    }
    .status {
      margin: 0;
      color: var(--sb-muted, #67625a);
      font-size: var(--sb-text-xs, 12px);
    }
    button.link {
      margin-left: auto;
      padding: 0;
      font-size: var(--sb-text-xs, 12px);
      font-weight: var(--sb-weight, 400);
      color: var(--sb-accent, #145f8a);
      background: none;
      border: none;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    /* The inputs: a native popover, so Esc and a click outside close it. */
    [popover] {
      box-sizing: border-box;
      width: min(720px, calc(100vw - 32px));
      max-height: calc(100vh - 64px);
      overflow: auto;
      padding: 16px 20px;
      color: var(--sb-text, #1c1a17);
      background: var(--sb-bg, #f7f6f2);
      border: 1px solid var(--sb-line-strong, #c4bfb5);
      border-radius: var(--sb-radius, 3px);
      font-size: var(--sb-text-sm, 13px);
      line-height: 1.45;
    }
    [popover]::backdrop {
      background: rgb(0 0 0 / 0.2);
    }
    .popover-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }
    h2 {
      margin: 0;
      font-size: var(--sb-text-md, 15px);
      font-weight: var(--sb-weight-strong, 600);
    }
    pre {
      margin: 0;
      overflow-x: auto;
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: var(--sb-text-sm, 13px);
      line-height: 1.5;
    }
    .status.bad {
      color: var(--sb-error, #b3261e);
    }
    textarea {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      padding: 5px 8px;
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: var(--sb-text-sm, 13px);
      line-height: 1.45;
      color: inherit;
      background: var(--sb-field, #fff);
      border: 1px solid var(--sb-line-strong, #c4bfb5);
      border-radius: var(--sb-radius, 3px);
      resize: vertical;
      tab-size: 2;
    }
    button {
      display: inline-flex;
      align-items: center;
      padding: 3px 10px;
      font: inherit;
      font-size: var(--sb-text-sm, 13px);
      font-weight: var(--sb-weight-strong, 600);
      color: inherit;
      background: var(--sb-field, #fff);
      border: 1px solid var(--sb-line-strong, #c4bfb5);
      border-radius: var(--sb-radius, 3px);
      cursor: pointer;
    }
    button:hover {
      border-color: var(--sb-text, #1c1a17);
    }
    :focus-visible {
      outline: 2px solid var(--sb-accent, #145f8a);
      outline-offset: 1px;
    }
    .actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
      border-top: 1px solid var(--sb-line, #dedad2);
    }
    li {
      display: grid;
      grid-template-columns: 5.5em minmax(0, 1fr);
      gap: 10px;
      align-items: baseline;
      padding: 6px 0;
      border-bottom: 1px solid var(--sb-line, #dedad2);
      font-size: var(--sb-text-sm, 13px);
    }
    li.error .message {
      color: var(--sb-error, #b3261e);
    }
    li button {
      justify-self: start;
      font-variant-numeric: tabular-nums;
    }
    .where {
      color: var(--sb-muted, #67625a);
      font-size: var(--sb-text-xs, 12px);
    }
    .message {
      overflow-wrap: anywhere;
    }
  `;

  declare value: Value;
  declare schema: JsonSchema;
  declare settings: unknown;
  declare issues: Issue[];
  declare status: Status;

  #gl: WebGL2RenderingContext | null | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** What was last checked: the source and the number of channels. */
  #checked: string | undefined;
  #rest: { of: JsonSchema; schema: JsonSchema } | undefined;

  constructor() {
    super();
    this.issues = [];
    this.status = { kind: "checking" };
  }

  get #source(): string {
    const source = this.value?.source;
    return typeof source === "string" ? source : "";
  }

  get #channels(): number {
    const channels = this.value?.channels;
    return Array.isArray(channels) ? channels.length : 0;
  }

  protected override willUpdate() {
    const key = `${this.#channels}\n${this.#source}`;
    if (key !== this.#checked) {
      // The first check runs at once; edits wait for typing to pause.
      const first = this.#checked === undefined;
      this.#checked = key;
      clearTimeout(this.#timer);
      if (first) this.#check();
      else this.#timer = setTimeout(() => this.#check(), CHECK_DELAY_MS);
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.#timer);
  }

  /** Checks the source as the screens would compile it. */
  #check() {
    const source = this.#source;
    const found = check(source, this.#channels);
    if (found.some((d) => d.severity === "error")) {
      this.status = { kind: "done", diagnostics: found };
      return;
    }
    this.#gl ??= document.createElement("canvas").getContext("webgl2");
    const gl = this.#gl;
    if (!gl || gl.isContextLost()) {
      this.#gl = undefined;
      this.status = { kind: "unavailable" };
      return;
    }
    const compiled = compile(gl, source);
    if (compiled.ok) gl.deleteProgram(compiled.program);
    this.status = {
      kind: "done",
      diagnostics: compiled.ok ? found : [...compiled.diagnostics, ...found],
    };
  }

  #emit(value: Value) {
    this.value = value;
    this.dispatchEvent(new CustomEvent("change", { detail: { value } }));
  }

  #setSource(source: string) {
    this.#emit({ ...this.value, source });
  }

  async #open(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) this.#setSource(await file.text());
  }

  /** Selects line `line` of the source and scrolls to it. */
  #goTo(line: number) {
    const textarea = this.renderRoot.querySelector("textarea");
    if (!textarea) return;
    const lines = this.#source.split("\n");
    const start = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
    const end = start + (lines[line - 1]?.length ?? 0);
    textarea.focus();
    textarea.setSelectionRange(start, end);
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 19;
    textarea.scrollTop = Math.max(0, (line - 3) * lineHeight);
  }

  /** The schema without `source`, which this editor renders itself. */
  #restSchema(): JsonSchema {
    if (this.#rest?.of !== this.schema) {
      const properties = { ...(this.schema.properties as Record<string, unknown>) };
      delete properties.source;
      const required = Array.isArray(this.schema.required)
        ? this.schema.required.filter((key) => key !== "source")
        : undefined;
      this.#rest = { of: this.schema, schema: { ...this.schema, properties, required } };
    }
    return this.#rest.schema;
  }

  #statusLine() {
    const status = this.status;
    if (status.kind === "checking") return html`<span class="status">Checking…</span>`;
    if (status.kind === "unavailable") {
      return html`<span class="status">Not checked: this browser has no WebGL2.</span>`;
    }
    const errors = status.diagnostics.filter((d) => d.severity === "error").length;
    if (errors === 0) return html`<span class="status">Compiles</span>`;
    return html`<span class="status bad">${errors} ${errors === 1 ? "error" : "errors"}</span>`;
  }

  #diagnostics() {
    const status = this.status;
    if (status.kind !== "done" || status.diagnostics.length === 0) return nothing;
    return html`<ul aria-label="Problems">
      ${status.diagnostics.map(
        (d) => html`<li class=${d.severity}>
          ${
            d.line === undefined
              ? html`<span class="where">${d.severity === "error" ? "Error" : "Warning"}</span>`
              : html`<button type="button" @click=${() => this.#goTo(d.line as number)}>
                  Line ${d.line}
                </button>`
          }
          <span class="message">${d.message}</span>
        </li>`,
      )}
    </ul>`;
  }

  override render() {
    if (!this.schema) return nothing;
    const { source: _, ...rest } = this.value ?? {};
    const issues = this.issues ?? [];
    const sourceIssues = issues.filter((issue) => issue.path[0] === "source");
    return html`<div class="field">
        <div class="head">
          <label for="source">Shader</label>
          ${this.#statusLine()}
          <button type="button" class="link" popovertarget="inputs">Shader inputs</button>
        </div>
        ${inputs}
        <textarea
          id="source"
          rows="18"
          spellcheck="false"
          autocomplete="off"
          wrap="off"
          .value=${this.#source}
          @input=${(e: Event) => this.#setSource((e.target as HTMLTextAreaElement).value)}
        ></textarea>
        <div class="actions">
          <button
            type="button"
            @click=${() => this.renderRoot.querySelector<HTMLInputElement>("#file")?.click()}
          >
            Open file…
          </button>
          <input
            id="file"
            type="file"
            hidden
            accept=".glsl,.frag,.fs,.txt,text/plain"
            @change=${(e: Event) => this.#open(e)}
          />
        </div>
        ${sourceIssues.map((issue) => html`<p class="status bad" role="alert">${issue.message}</p>`)}
        ${this.#diagnostics()}
      </div>
      <sb-form
        .schema=${this.#restSchema()}
        .value=${rest}
        .issues=${issues.filter((issue) => issue.path[0] !== "source")}
        @change=${(e: ValueChangeEvent) => {
          e.stopPropagation();
          this.#emit({ ...(e.detail.value as Record<string, unknown>), source: this.#source });
        }}
      ></sb-form>`;
  }
}

/** The inputs the shader gets, listed the way Shadertoy lists its own. */
const INPUTS = `uniform vec3      iResolution;           // viewport resolution (in pixels)
uniform float     iTime;                 // shader playback time (in seconds)
uniform float     iTimeDelta;            // render time (in seconds)
uniform float     iFrameRate;            // shader frame rate
uniform int       iFrame;                // shader playback frame
uniform vec3      iChannelResolution[4]; // channel resolution (in pixels)
uniform sampler2D iChannel0..3;          // input channel, from Channels
uniform vec4      iDate;                 // (year, month, day, time in seconds)
uniform vec3      sbText;                // theme text colour
uniform vec3      sbMuted;               // theme muted colour
uniform vec3      sbAccent;              // theme accent colour
uniform vec3      sbSurface;             // theme surface colour`;

const inputs = html`<div id="inputs" popover aria-labelledby="inputs-title">
  <div class="popover-head">
    <h2 id="inputs-title">Shader inputs</h2>
    <button type="button" popovertarget="inputs" popovertargetaction="hide">Close</button>
  </div>
  <pre><code>${INPUTS}</code></pre>
</div>`;

customElements.define("sb-shader-editor", ShaderEditor);
