import type { ShowState } from "@storbild/core";
import type { ViewerContext } from "@storbild/plugin-sdk/viewer";
import { ClockSync, hasStaleModules, SyncClient, type Timers } from "@storbild/viewer";
import { css, html, LitElement, nothing, type PropertyDeclarations } from "lit";
import { toLogin } from "./api.ts";
import "./live-panel.ts";
import { type Section, sections } from "./sections.ts";
import "./strip.ts";
import { controls } from "./styles.ts";

const timers: Timers = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number | undefined),
};

/** Monotonic, so local NTP adjustments don't move the estimated server clock. */
const localNow = () => performance.timeOrigin + performance.now();

/** Fetches without caching; a 401 means the session is gone, so it goes to the login page. */
async function fetchApi(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (response.status === 401) toLogin();
  return response;
}

type Theme = "system" | "light" | "dark";
const themeKey = "storbild.theme";

function storedTheme(): Theme {
  try {
    const theme = localStorage.getItem(themeKey);
    return theme === "light" || theme === "dark" ? theme : "system";
  } catch {
    return "system";
  }
}

const sectionAt = (path: string): Section | undefined =>
  sections.find((section) => section.path === path);

/**
 * The admin shell (DESIGN.md §8.2): sidebar, the pinned now/next strip and the current page.
 * It follows the show over `/api/events` with the viewer's sync client, so the strip and its
 * preview need no second stream.
 */
export class Admin extends LitElement {
  static override properties: PropertyDeclarations = {
    state: { state: true },
    connected: { state: true },
    path: { state: true },
    theme: { state: true },
  };

  static override styles = [
    controls,
    css`
      :host {
        display: grid;
        grid-template-columns: 200px minmax(0, 1fr);
        height: 100%;
      }
      nav {
        display: flex;
        flex-direction: column;
        background: var(--sb-bg-sunken);
        border-right: 1px solid var(--sb-line);
        padding: 16px 0 12px;
      }
      .brand {
        font-size: var(--sb-text-lg);
        font-weight: var(--sb-weight-strong);
        letter-spacing: -0.01em;
        padding: 0 20px 16px;
      }
      nav ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      nav a {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        padding: 6px 20px;
        color: var(--sb-text);
        text-decoration: none;
        border-left: 3px solid transparent;
      }
      nav a:hover {
        background: var(--sb-bg);
      }
      nav a[aria-current="page"] {
        border-left-color: var(--sb-accent);
        background: var(--sb-bg);
        font-weight: var(--sb-weight-strong);
      }
      nav a .later {
        font-size: var(--sb-text-xs);
        color: var(--sb-muted);
        font-weight: var(--sb-weight);
      }
      .foot {
        margin-top: auto;
        padding: 12px 20px 0;
        border-top: 1px solid var(--sb-line);
        display: grid;
        gap: 10px;
        font-size: var(--sb-text-sm);
      }
      .connection {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--sb-muted);
      }
      .connection::before {
        content: "";
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--sb-error);
      }
      .connection.on::before {
        background: var(--sb-live);
      }
      .foot select {
        width: 100%;
      }
      .foot form button {
        width: 100%;
        justify-content: center;
      }
      main {
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: auto;
      }
      .placeholder {
        padding: 20px 24px;
      }
      .placeholder h1 {
        font-size: var(--sb-text-xl);
        font-weight: var(--sb-weight-strong);
        margin: 0 0 8px;
        letter-spacing: -0.01em;
      }
    `,
  ];

  declare state: ShowState | undefined;
  declare connected: boolean;
  declare path: string;
  declare theme: Theme;

  readonly clock = new ClockSync({ url: "/api/time", fetch: fetchApi, localNow, timers });
  readonly sync = new SyncClient({
    url: "/api/events",
    probeUrl: "/api/time",
    openEventSource: (url) => {
      const source = new EventSource(url);
      // A stream refused with 401 closes for good; check whether the session has expired.
      source.addEventListener("error", () => {
        if (source.readyState === EventSource.CLOSED) void fetchApi("/api/time").catch(() => {});
      });
      source.addEventListener("open", () => {
        this.connected = true;
      });
      source.addEventListener("error", () => {
        this.connected = source.readyState === EventSource.OPEN;
      });
      return source;
    },
    fetch: fetchApi,
    timers,
    reload: () => location.reload(),
    onState: (state) => {
      if (hasStaleModules(state)) location.reload();
      else this.state = state;
    },
    onConnect: () => void this.clock.sync(),
  });
  readonly ctx: ViewerContext = {
    serverNow: this.clock.serverNow,
    assetUrl: (assetId) => `/assets/${encodeURIComponent(assetId)}`,
  };

  readonly #onPopState = () => {
    this.path = location.pathname;
  };

  readonly #onVisibility = () => {
    if (document.visibilityState === "visible") void this.clock.sync();
  };

  constructor() {
    super();
    this.connected = false;
    this.theme = storedTheme();
    this.path = sectionAt(location.pathname) ? location.pathname : "/live";
    if (this.path !== location.pathname) history.replaceState(null, "", this.path);
  }

  override connectedCallback() {
    super.connectedCallback();
    this.clock.start();
    this.sync.start();
    window.addEventListener("popstate", this.#onPopState);
    document.addEventListener("visibilitychange", this.#onVisibility);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.sync.stop();
    this.clock.stop();
    window.removeEventListener("popstate", this.#onPopState);
    document.removeEventListener("visibilitychange", this.#onVisibility);
  }

  override render() {
    const current = sectionAt(this.path);
    return html`
      <nav aria-label="Sections">
        <div class="brand">Storbild</div>
        <ul>
          ${sections.map(
            (section) => html`<li>
              <a
                href=${section.path}
                aria-current=${section.path === this.path ? "page" : nothing}
                @click=${(event: MouseEvent) => this.#navigate(event, section.path)}
              >
                ${section.label}
                ${"milestone" in section ? html`<span class="later">later</span>` : nothing}
              </a>
            </li>`,
          )}
        </ul>
        <div class="foot">
          <span class="connection ${this.connected ? "on" : ""}" role="status">
            ${this.connected ? "Connected" : "Reconnecting…"}
          </span>
          <select aria-label="Colour scheme" @change=${this.#setTheme}>
            ${(["system", "light", "dark"] as const).map(
              (theme) =>
                html`<option value=${theme} ?selected=${theme === this.theme}>
                  ${theme === "system" ? "System theme" : theme === "light" ? "Light" : "Dark"}
                </option>`,
            )}
          </select>
          <form method="post" action="/logout"><button type="submit">Log out</button></form>
        </div>
      </nav>
      <main>
        <sb-strip .state=${this.state} .ctx=${this.ctx}></sb-strip>
        ${
          current === undefined || !("milestone" in current)
            ? html`<sb-live-panel .state=${this.state} .ctx=${this.ctx}></sb-live-panel>`
            : html`<div class="placeholder">
                <h1>${current.label}</h1>
                <p class="muted">This page arrives in ${current.milestone}.</p>
              </div>`
        }
      </main>
    `;
  }

  #navigate(event: MouseEvent, path: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    if (path === this.path) return;
    history.pushState(null, "", path);
    this.path = path;
  }

  #setTheme = (event: Event) => {
    const theme = (event.target as HTMLSelectElement).value as Theme;
    this.theme = theme;
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem(themeKey);
      else localStorage.setItem(themeKey, theme);
    } catch {
      // Not remembered; it still applies now.
    }
  };
}

customElements.define("sb-admin", Admin);
