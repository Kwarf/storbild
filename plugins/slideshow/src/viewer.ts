import type { PluginConfig, PluginSettings } from "@storbild/plugin-sdk";
import { StorbildScene } from "@storbild/plugin-sdk/viewer";
import { css, html, type PropertyValues } from "lit";
import type plugin from "./plugin.ts";

type Config = PluginConfig<typeof plugin, "images">;
type Settings = PluginSettings<typeof plugin>;

/** The crossfade between two images, in ms. */
const FADE_MS = 1_000;

/**
 * Full-bleed images, one after another. Which image shows is worked out from server time since
 * the scene entered, so every screen shows the same one. Images that fail to load are skipped.
 */
export class Slideshow extends StorbildScene<Config, Settings> {
  static override properties = {
    ...StorbildScene.properties,
    index: { state: true },
  };

  static override styles = css`
    :host {
      position: relative;
      display: block;
      height: 100%;
      overflow: hidden;
      background: #000;
    }
    img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      transition: opacity ${FADE_MS}ms ease-in-out;
    }
    img.shown {
      opacity: 1;
    }
  `;

  declare index: number;
  #enteredAt: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Asset IDs that failed to load. */
  readonly #failed = new Set<string>();

  constructor() {
    super();
    this.index = 0;
  }

  get #images(): string[] {
    return this.config.images.filter((id) => !this.#failed.has(id));
  }

  get #perImageMs(): number {
    return this.config.perImageMs ?? this.settings.perImageMs;
  }

  override async prepare() {
    await Promise.all(
      this.config.images.map(async (id) => {
        const image = new Image();
        image.src = this.ctx.assetUrl(id);
        try {
          await image.decode();
        } catch {
          this.#failed.add(id);
        }
      }),
    );
    this.requestUpdate();
  }

  override enter(at: number) {
    this.#enteredAt = at;
    this.#advance();
  }

  override dispose() {
    clearTimeout(this.#timer);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.#timer);
  }

  protected override updated(changes: PropertyValues<this>) {
    // A changed config or settings can move the boundaries.
    if ((changes.has("config") || changes.has("settings")) && this.#enteredAt !== undefined) {
      this.#advance();
    }
  }

  /** Shows the image for the current time and waits for the next one's turn. */
  #advance() {
    clearTimeout(this.#timer);
    const count = this.#images.length;
    if (this.#enteredAt === undefined || count < 2) {
      this.index = 0;
      return;
    }
    const per = this.#perImageMs;
    const elapsed = Math.max(0, this.ctx.serverNow() - this.#enteredAt);
    this.index = Math.floor(elapsed / per) % count;
    this.#timer = setTimeout(() => this.#advance(), per - (elapsed % per));
  }

  override render() {
    const images = this.#images;
    const shown = images.length > 0 ? this.index % images.length : -1;
    return images.map(
      (id, i) => html`<img
        class=${i === shown ? "shown" : ""}
        style="object-fit: ${this.config.fit}"
        src=${this.ctx.assetUrl(id)}
        alt=""
        @error=${() => {
          this.#failed.add(id);
          this.requestUpdate();
        }}
      />`,
    );
  }
}

customElements.define("sb-slideshow", Slideshow);
