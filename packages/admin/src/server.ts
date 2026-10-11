// What the server needs to serve the admin: the page shells and the font files. Runs on the
// server, so nothing here touches the DOM.
import { sections, shellPaths } from "./sections.ts";
import { base, fontFaces, tokens } from "./tokens.ts";

export { sections, shellPaths };

/** Font files by name, as file URLs, to be served under the `fontBase` given to the pages. */
export const fontFiles: ReadonlyMap<string, URL> = new Map(
  [400, 600].map((weight) => {
    const name = `instrument-sans-latin-${weight}-normal.woff2`;
    return [
      name,
      new URL(
        `files/${name}`,
        import.meta.resolve(`@fontsource/instrument-sans/latin-${weight}.css`),
      ),
    ];
  }),
);

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** JSON that is safe inside a `<script>` element. */
const scriptJson = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");

/** The theme toggle's choice, applied before first paint so the page doesn't flash. */
const themeScript = `try{const t=localStorage.getItem("storbild.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch{}`;

function head(title: string, fontBase: string, extra = ""): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<script>${themeScript}</script>
<style>
${fontFaces(fontBase)}
${tokens}
${base}
</style>
${extra}`;
}

export interface AdminPageOptions {
  /** URL of the admin bundle's entry. */
  script: string;
  importMap: unknown;
  fontBase: string;
}

/** The admin shell: `<sb-admin>` fills the window. */
export function adminPage({ script, importMap, fontBase }: AdminPageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
${head(
  "Storbild admin",
  fontBase,
  `<script type="importmap">${scriptJson(importMap)}</script>
<style>sb-admin { height: 100%; }</style>
<script type="module" src="${escapeHtml(script)}"></script>`,
)}
</head>
<body><sb-admin></sb-admin></body>
</html>
`;
}

export interface LoginPageOptions {
  fontBase: string;
  username?: string;
  error?: string;
}

/** The login form. Server-rendered, so it works before (and without) the admin bundle. */
export function loginPage({ fontBase, username = "", error }: LoginPageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
${head(
  "Log in · Storbild",
  fontBase,
  `<style>
main { max-width: 320px; margin: 0 auto; padding: 18vh 24px 0; }
h1 { font-size: var(--sb-text-xl); font-weight: var(--sb-weight-strong); margin: 0 0 24px; letter-spacing: -0.01em; }
label { display: block; font-size: var(--sb-text-sm); color: var(--sb-muted); margin: 0 0 4px; }
input {
  box-sizing: border-box; width: 100%; margin: 0 0 16px; padding: 7px 9px;
  font: inherit; color: var(--sb-text); background: var(--sb-field);
  border: 1px solid var(--sb-line-strong); border-radius: var(--sb-radius);
}
input:focus-visible, button:focus-visible { outline: 2px solid var(--sb-accent); outline-offset: 1px; }
button {
  font: inherit; font-weight: var(--sb-weight-strong); padding: 7px 14px; cursor: pointer;
  color: var(--sb-accent-text); background: var(--sb-accent);
  border: 1px solid var(--sb-accent); border-radius: var(--sb-radius);
}
.error { color: var(--sb-error); font-size: var(--sb-text-sm); margin: 0 0 16px; }
</style>`,
)}
</head>
<body>
<main>
<h1>Storbild</h1>
<form method="post" action="/login">
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<label for="username">Username</label>
<input id="username" name="username" autocomplete="username" required value="${escapeHtml(username)}"${username ? "" : " autofocus"}>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required${username ? " autofocus" : ""}>
<button type="submit">Log in</button>
</form>
</main>
</body>
</html>
`;
}
