import type { PluginConfig, PluginSettings } from "@storbild/plugin-sdk";
import { StorbildOverlay, StorbildScene } from "@storbild/plugin-sdk/viewer";
import DOMPurify from "dompurify";
import { css, html, type PropertyValues } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type plugin from "./plugin.ts";
import { renderMarkdown } from "./render.ts";

type Config = PluginConfig<typeof plugin, "text">;
type WidgetConfig = PluginConfig<typeof plugin, "widget">;
type Settings = PluginSettings<typeof plugin>;

/** How far the text may shrink to fit, as a fraction of `fontScale`, and the step. */
const MIN_FIT = 0.4;
const FIT_STEP = 0.92;

/** Markdown is rendered and then sanitized; raw HTML may be in it (ADR 0015). */
const sanitize = (markdown: string) =>
  DOMPurify.sanitize(renderMarkdown(markdown), { FORBID_TAGS: ["iframe", "form", "style"] });

/** The markdown elements, sized in em from the host's font size. */
const typography = css`
  h1,
  h2,
  h3,
  h4 {
    margin: 0 0 0.4em;
    font-family: var(--sb-font-heading, sans-serif);
    line-height: 1.1;
  }
  h1 {
    font-size: 2em;
  }
  h2 {
    font-size: 1.5em;
  }
  h3,
  h4 {
    font-size: 1.15em;
  }
  p,
  ul,
  ol,
  blockquote,
  pre,
  table {
    margin: 0 0 0.6em;
  }
  .body > :last-child {
    margin-bottom: 0;
  }
  ul,
  ol {
    padding-left: 1.2em;
  }
  li::marker {
    color: var(--sb-color-accent, #e8a33d);
  }
  a {
    color: var(--sb-color-accent, #e8a33d);
    text-decoration: none;
  }
  strong {
    font-weight: 700;
  }
  blockquote {
    padding: 0.3em 0.8em;
    border-left: 0.2em solid var(--sb-color-accent, #e8a33d);
    background: var(--sb-color-surface, #15171c);
  }
  blockquote > :last-child {
    margin-bottom: 0;
  }
  code {
    padding: 0 0.2em;
    font-family: var(--sb-font-mono, monospace);
    font-size: 0.9em;
    background: var(--sb-color-surface, #15171c);
    border-radius: 4px;
  }
  pre {
    padding: 0.5em 0.7em;
    background: var(--sb-color-surface, #15171c);
    border-radius: 8px;
    white-space: pre-wrap;
  }
  pre code {
    padding: 0;
    background: none;
  }
  table {
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  th,
  td {
    padding: 0.2em 0.8em 0.2em 0;
    text-align: left;
  }
  th {
    font-family: var(--sb-font-heading, sans-serif);
    color: var(--sb-color-muted, #9aa0aa);
  }
  hr {
    margin: 0.8em 0;
    border: 0;
    border-top: 2px solid var(--sb-color-muted, #9aa0aa);
  }
  img {
    max-width: 100%;
    max-height: 60vh;
  }
`;

/** Text alignment from the `align` attribute; tables are blocks, so they get margins. */
const alignment = css`
  :host([align="center"]) .body {
    text-align: center;
  }
  :host([align="right"]) .body {
    text-align: right;
  }
  :host([align="center"]) table {
    margin-inline: auto;
  }
  :host([align="right"]) table {
    margin-left: auto;
  }
`;

/** Markdown in the theme's typography, shrunk until it fits the screen. */
export class MarkdownScene extends StorbildScene<Config, Settings> {
  static override styles = [
    typography,
    alignment,
    css`
      :host {
        display: flex;
        flex-direction: column;
        justify-content: center;
        box-sizing: border-box;
        height: 100%;
        padding: var(--sb-safe-area, 96px);
        color: var(--sb-color-text, #fff);
        font-family: var(--sb-font-body, sans-serif);
      }
      :host([vertical-align="top"]) {
        justify-content: flex-start;
      }
      :host([vertical-align="bottom"]) {
        justify-content: flex-end;
      }
      .content {
        max-height: 100%;
        overflow: hidden;
        font-size: calc(48px * var(--scale, 1));
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      /* A new block formatting context, so its height includes its children's margins. */
      .body {
        display: flow-root;
      }
    `,
  ];

  /** Bumped on every fit, so a fit waiting for images gives way to a newer one. */
  #fitting = 0;

  protected override updated(changes: PropertyValues<this>) {
    this.setAttribute("align", this.config.align);
    this.setAttribute("vertical-align", this.config.verticalAlign);
    if (changes.has("config") || changes.has("settings")) void this.#fit();
  }

  override async prepare() {
    await this.updateComplete;
    await this.#fit();
  }

  /**
   * Waits for the body's images, then steps `--scale` down until the body fits. It compares the
   * body's layout height, not `scrollHeight`: Firefox counts glyphs that stick out of a tight
   * line height (a lone heading) as overflow, which shrinks with the text and never goes away.
   */
  async #fit() {
    const run = ++this.#fitting;
    const content = this.renderRoot.querySelector<HTMLElement>(".content");
    const body = this.renderRoot.querySelector<HTMLElement>(".body");
    if (!content || !body) return;
    await Promise.all(
      [...body.querySelectorAll("img")].map((img) => img.decode().catch(() => undefined)),
    );
    if (run !== this.#fitting) return;
    const full = this.settings.fontScale;
    let scale = full;
    content.style.setProperty("--scale", String(scale));
    while (scale > full * MIN_FIT && body.offsetHeight > content.clientHeight + 1) {
      scale *= FIT_STEP;
      content.style.setProperty("--scale", String(scale));
    }
  }

  override render() {
    return html`<div class="content">
      <div class="body">${unsafeHTML(sanitize(this.config.content))}</div>
    </div>`;
  }
}

/**
 * Markdown on the theme's surface, sized by its slot: it wraps at the slot's width and is
 * clipped beyond its height (ADR 0012), so it isn't shrunk to fit.
 */
export class MarkdownWidget extends StorbildOverlay<WidgetConfig, Settings> {
  static override styles = [
    typography,
    alignment,
    css`
      :host {
        display: block;
        box-sizing: border-box;
        padding: 16px 28px;
        border-radius: 8px;
        background: var(--sb-color-surface, #15171c);
        color: var(--sb-color-text, #fff);
        font-family: var(--sb-font-body, sans-serif);
        font-size: calc(28px * var(--scale, 1));
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      /* The widget is already on the surface colour, so these are tinted from the text. */
      blockquote,
      code,
      pre {
        background: color-mix(in srgb, var(--sb-color-text, #fff) 10%, transparent);
      }
      pre code {
        background: none;
      }
      img {
        max-height: 200px;
      }
    `,
  ];

  protected override updated() {
    this.setAttribute("align", this.config.align);
    this.style.setProperty("--scale", String(this.settings.fontScale));
  }

  override async prepare() {
    await this.updateComplete;
    const images = this.renderRoot.querySelectorAll("img");
    await Promise.all([...images].map((img) => img.decode().catch(() => undefined)));
  }

  override render() {
    return html`<div class="body">${unsafeHTML(sanitize(this.config.content))}</div>`;
  }
}

customElements.define("sb-markdown-scene", MarkdownScene);
customElements.define("sb-markdown-widget", MarkdownWidget);
