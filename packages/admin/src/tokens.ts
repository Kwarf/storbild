// Design tokens (DESIGN.md §8.3). Plain CSS, so the server-rendered login page and the Lit
// shell share them. Components use only these custom properties, never raw colours.

const light = `
  color-scheme: light;
  --sb-bg: #f8f7f4;
  --sb-bg-sunken: #efede8;
  --sb-field: #ffffff;
  --sb-line: #dedad2;
  --sb-line-strong: #c4bfb5;
  --sb-text: #1c1a17;
  --sb-muted: #67625a;
  --sb-track: #e6e2da;
  --sb-accent: #145f8a;
  --sb-accent-text: #ffffff;
  --sb-live: #1d7a3e;
  --sb-override: #a35a00;
  --sb-error: #b3261e;
  --sb-scheduled: #145f8a;
`;

const dark = `
  color-scheme: dark;
  --sb-bg: #171614;
  --sb-bg-sunken: #1f1e1b;
  --sb-field: #24221f;
  --sb-line: #33302c;
  --sb-line-strong: #4a4640;
  --sb-text: #ece9e3;
  --sb-muted: #a29d94;
  --sb-track: #2c2a26;
  --sb-accent: #6cb4de;
  --sb-accent-text: #0e1a22;
  --sb-live: #5cc47f;
  --sb-override: #e9a54c;
  --sb-error: #f2776d;
  --sb-scheduled: #6cb4de;
`;

/**
 * Tokens for `:root`. Light and dark follow the system preference unless `data-theme` on the
 * root element picks one.
 */
export const tokens = `
:root {
  ${light}
  --sb-font: "Instrument Sans", system-ui, sans-serif;
  --sb-text-xs: 12px;
  --sb-text-sm: 13px;
  --sb-text-md: 15px;
  --sb-text-lg: 18px;
  --sb-text-xl: 24px;
  --sb-weight: 400;
  --sb-weight-strong: 600;
  --sb-radius: 3px;
  --sb-space: 8px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { ${dark} }
}
:root[data-theme="dark"] { ${dark} }
`;

/** `@font-face` rules for the files in `fontFiles`, served under `base`. */
export function fontFaces(base: string): string {
  return [400, 600]
    .map(
      (weight) => `@font-face {
  font-family: "Instrument Sans";
  font-style: normal;
  font-weight: ${weight};
  font-display: swap;
  src: url("${base}instrument-sans-latin-${weight}-normal.woff2") format("woff2");
}`,
    )
    .join("\n");
}

/** Base page styles shared by the shell and the login page. */
export const base = `
html, body { margin: 0; height: 100%; }
body {
  background: var(--sb-bg);
  color: var(--sb-text);
  font: var(--sb-weight) var(--sb-text-md) / 1.45 var(--sb-font);
  -webkit-font-smoothing: antialiased;
}
`;
