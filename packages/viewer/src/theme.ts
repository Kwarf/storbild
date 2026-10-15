import { DEFAULT_WIDGET_FRAME, type FontRef, type Theme, type WidgetFrame } from "@storbild/core";
import { withTimeout } from "./modules.ts";

/** The theme's safe area and overlay gap when it doesn't set them, px (ADR 0012). */
export const DEFAULT_SAFE_AREA = 96;
export const DEFAULT_GAP = 24;

const SHADOWS = {
  none: { shadow: "", margin: 0 },
  soft: { shadow: "0 8px 24px rgb(0 0 0 / 0.35)", margin: 32 },
  deep: { shadow: "0 2px 6px rgb(0 0 0 / 0.3), 0 16px 48px rgb(0 0 0 / 0.6)", margin: 64 },
  glow: {
    shadow: "0 0 32px color-mix(in srgb, var(--sb-color-accent) 35%, transparent)",
    margin: 48,
  },
};

/** A light line inside the top edge of a glass frame. */
const LIT_EDGE = "inset 0 1px 0 color-mix(in srgb, var(--sb-color-text) 28%, transparent)";

/** The CSS custom properties the compositor draws widget frames with (ADR 0028). */
export function widgetVariables(frame: WidgetFrame = {}): Record<string, string> {
  const d = DEFAULT_WIDGET_FRAME;
  const style = frame.style ?? d.style;
  const opacity = frame.opacity ?? d.opacity;
  const blur = frame.blur ?? d.blur;
  const radius = frame.radius ?? d.radius;
  const shadow = frame.shadow ?? d.shadow;
  if (style === "none") {
    return {
      "--sb-widget-padding": "0",
      "--sb-widget-border": "none",
      "--sb-widget-radius": "0",
      "--sb-widget-background": "transparent",
      "--sb-widget-backdrop": "none",
      "--sb-widget-shadow": "none",
      "--sb-widget-text-shadow": "0 2px 12px rgb(0 0 0 / 0.6), 0 0 2px rgb(0 0 0 / 0.5)",
      "--sb-widget-shadow-margin": "16px",
      // Room for the text shadow, which the widget's own clip would cut off.
      "--sb-widget-clip-margin": "16px",
    };
  }
  // A shadow this viewer doesn't know, from a newer server, falls back to the default.
  const outer = SHADOWS[shadow] ?? SHADOWS[DEFAULT_WIDGET_FRAME.shadow];
  const glass = style === "glass";
  const shadows = [glass ? LIT_EDGE : "", outer.shadow].filter(Boolean);
  return {
    "--sb-widget-padding": "16px 24px",
    "--sb-widget-border": glass
      ? "1px solid color-mix(in srgb, var(--sb-color-text) 18%, transparent)"
      : "none",
    "--sb-widget-radius": `${radius}px`,
    "--sb-widget-background": glass
      ? `color-mix(in srgb, var(--sb-color-surface) ${Math.round(opacity * 100)}%, transparent)`
      : "var(--sb-color-surface)",
    "--sb-widget-backdrop": glass && blur > 0 ? `blur(${blur}px) saturate(140%)` : "none",
    "--sb-widget-shadow": shadows.length > 0 ? shadows.join(", ") : "none",
    "--sb-widget-text-shadow": "none",
    "--sb-widget-shadow-margin": `${outer.margin}px`,
    "--sb-widget-clip-margin": "0px",
  };
}

/** How long a theme waits for its fonts before it is shown anyway (ADR 0014). */
export const FONT_TIMEOUT_MS = 5_000;

/** FNV-1a, as a short name that changes with the faces. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const faceKey = (font: FontRef) =>
  (font.faces ?? []).map((face) => `${face.assetId}:${face.weight}:${face.style}`).join(",");

/**
 * The family name a font's uploaded faces are registered under. It is unique per set of faces,
 * so two themes, or a theme and the admin around a preview, never mix their files.
 */
export function familyName(font: FontRef): string | undefined {
  return font.faces?.length ? `sbf-${hash(faceKey(font))}` : undefined;
}

/** The CSS font stack for a font: its uploaded family, or `family` as the screen has it. */
export function fontStack(font: FontRef): string {
  const name = familyName(font);
  return name ? `"${name}", sans-serif` : font.family;
}

/** The theme's CSS custom properties, which plugins read (DESIGN.md §4.6). */
export function themeVariables(theme: Theme): Record<string, string> {
  const { fonts, colors } = theme;
  return {
    "--sb-font-heading": fontStack(fonts.heading),
    "--sb-font-body": fontStack(fonts.body),
    "--sb-font-mono": fonts.mono ? fontStack(fonts.mono) : "monospace",
    "--sb-color-text": colors.text,
    "--sb-color-muted": colors.muted,
    "--sb-color-accent": colors.accent,
    "--sb-color-surface": colors.surface,
    "--sb-safe-area": `${theme.safeArea ?? DEFAULT_SAFE_AREA}px`,
    "--sb-gap": `${theme.gap ?? DEFAULT_GAP}px`,
    ...widgetVariables(theme.widgets),
  };
}

/** A key that changes exactly when a theme's uploaded fonts do. */
export function fontsKey(theme: Theme): string {
  const { heading, body, mono } = theme.fonts;
  return [heading, body, mono].map((font) => (font ? faceKey(font) : "")).join("|");
}

/**
 * The uploaded font faces of the document, added once each through the FontFace API. A
 * compositor shows a theme once `ensure` settles, so no fallback font is ever seen.
 */
class FontRegistry {
  readonly #faces = new Map<string, Promise<unknown>>();
  readonly #settled = new Map<string, Promise<void>>();
  readonly #done = new Set<string>();

  /** Whether `ensure` has settled for a theme's fonts. */
  ready(theme: Theme): boolean {
    return this.#done.has(fontsKey(theme));
  }

  /**
   * Loads a theme's faces. Settles when all are loaded, or after `FONT_TIMEOUT_MS`, so a
   * broken file can't hold the screen; it never rejects.
   */
  ensure(theme: Theme, assetUrl: (id: string) => string): Promise<void> {
    const key = fontsKey(theme);
    let settled = this.#settled.get(key);
    if (!settled) {
      const loads = Object.values(theme.fonts).flatMap((font) =>
        font ? this.#load(font, assetUrl) : [],
      );
      settled = withTimeout(Promise.all(loads), FONT_TIMEOUT_MS, "loading the theme's fonts")
        .then(
          () => {},
          (error) => console.error(error),
        )
        .finally(() => this.#done.add(key));
      this.#settled.set(key, settled);
    }
    return settled;
  }

  #load(font: FontRef, assetUrl: (id: string) => string): Promise<unknown>[] {
    const family = familyName(font);
    if (!family) return [];
    return (font.faces ?? []).map((face) => {
      const key = `${family}:${face.assetId}:${face.weight}:${face.style}`;
      let loading = this.#faces.get(key);
      if (!loading) {
        const fontFace = new FontFace(family, `url("${assetUrl(face.assetId)}") format("woff2")`, {
          weight: String(face.weight),
          style: face.style,
        });
        document.fonts.add(fontFace);
        loading = fontFace.load().catch((error: unknown) => {
          console.error(`font ${face.assetId} failed to load`, error);
        });
        this.#faces.set(key, loading);
      }
      return loading;
    });
  }
}

export const fonts = new FontRegistry();
