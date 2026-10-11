import type { FontRef, Theme } from "@storbild/core";
import { withTimeout } from "./modules.ts";

/** The theme's safe area and overlay gap when it doesn't set them, px (ADR 0012). */
export const DEFAULT_SAFE_AREA = 96;
export const DEFAULT_GAP = 24;

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
