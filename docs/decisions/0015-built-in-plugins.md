# 15. Built-in plugins

Date: 2026-10-11

## Status

Accepted. Refines DESIGN.md §6.4 and M9.

## Context

M9 (DESIGN.md §9) finishes the built-in plugins of §6.4. `announcement` and `slideshow` came
in M6b (ADR 0011) and `info`'s clock in M8 (ADR 0012), so `markdown`, `countdown`,
`info/wifi` and `now-playing` are left. These questions were open:

- The upstream event format for `now-playing` (§11). Its upstream service is private.
- How `markdown` turns text into HTML, and what it lets through.
- What a countdown shows once its target has passed, and when its overlay goes away.
- What the Wi-Fi QR code encodes, and how an operator checks it before it is on screen.
- Whether a built-in plugin may have third-party dependencies, and how they reach the browser.

## Decision

**`now-playing` leaves M9 and the built-ins.** It will be built in its own repository, next to
its private upstream, as an external plugin. The SDK already has what it needs:

- `server(ctx)` with `setPluginState`
- `staleAt()` for the stale-hide
- `singleton`

It will also be the first plugin loaded from outside `plugins/` (§6.3). The open question
about its event format moves with it.

**Plugin dependencies.** A plugin may depend on any package. `bundleBrowser` bundles it into
the plugin's browser modules. Only `lit`, `zod` and the SDK are external
(`pluginExternals`). Each module gets its own copy, so two plugins that use the same library
each ship it. The Biome rule for `plugins/` only blocks `@storbild/*` internals. The built-ins
pin exact versions: `marked` and `dompurify` in `markdown`, and `uqr` in `info`.

**Markdown.**

- `renderMarkdown(text)` runs `marked` with GFM and `breaks: true`, so a single newline is a
  line break as operators expect. It is pure and has no DOM, so it is unit-tested under Bun.
- The viewer passes the HTML through `DOMPurify` and renders it with `unsafeHTML` in the
  scene's shadow root. Raw HTML in the text is allowed and sanitized. DOMPurify's defaults
  strip scripts, event handlers and `javascript:` URLs, and `iframe`, `form` and `style` are
  forbidden on top of them.
- Links show as accent-coloured text. Screens aren't interactive.
- Images may point anywhere. Unlike assets, a remote image isn't served by Storbild and won't
  be there during an outage.
- Styles use only theme variables. The body shrinks to fit: `--scale` steps down from
  `fontScale` until the content fits the safe area, as the announcement panel does.

**Countdown.** The `countdown` plugin has a scene type, `countdown`, and an overlay type,
`widget`. Type names are unique within a plugin, so §6.4's "overlay `countdown`" can't be
literal.

- **Config.** Both take a `target` (`fields.datetime()`, server time) and an optional
  `doneText`. The scene has a `title`. The overlay has a `label` and `hideAfterMs`, default
  5 minutes.
- **Rounding.** The remaining time is rounded **up** to whole seconds, so `00:00` appears
  exactly at the target and never a second early.
- **Format.** `MM:SS` under an hour, `H:MM:SS` under a day, and `D d HH:MM:SS` from a day.
- **After the target.** Both show `doneText`, or `00:00` without one.
- **Hiding.** The overlay's `staleAt()` is `target + hideAfterMs`, so the compositor fades it
  out and closes its slot's gap after the event (ADR 0012). The scene runs for its rotation
  duration like any other.
- **Redrawing.** Both redraw on a timer aligned to the target's second boundaries, using
  `ctx.serverNow()`.

**Wi-Fi.** The `info` plugin gains a `wifi` overlay.

- **Config.** `{ ssid, password?, security: "WPA" | "WEP" | "none", hidden, showPassword,
  label? }`.
- **QR payload.** The QR code encodes the de facto standard payload
  `WIFI:T:<WPA|WEP|nopass>;S:<ssid>;P:<password>;H:true;;`. `\`, `;`, `,`, `:` and `"` are
  escaped with a backslash. `P` is left out for `nopass` and `H` for visible networks.
- **Encoding.** `uqr` encodes the payload at error correction level M with a 4-module quiet
  zone. The code is drawn as a single SVG path.
- **Colours.** The code is always black on a white tile, whatever the theme, because phone
  scanners expect dark modules on a light background. The rest of the panel follows the theme.
- **Custom editor.** `sb-info-wifi-editor` is registered from `info`'s admin module. It renders
  the generated `<sb-form>` from the schema it is given, next to a live preview of the QR code
  built from the same functions as the viewer. An operator can scan it with a phone before
  placing the widget. It is the first built-in to use the custom-editor path (ADR 0010).

## Consequences

- §6.4 lists five built-ins, and `now-playing` is an external plugin. §11 no longer lists its
  event format.
- Plugin browser modules grow by their dependencies, which are loaded only where they are
  used: `marked` and `dompurify` with the markdown scene, and `uqr` with the Wi-Fi widget and
  its editor.
- Operators can paste raw HTML into markdown. That's useful for small layout tweaks, and it is
  safe because it is sanitized.
- The countdown overlay hides itself after its event, so a stale countdown never stays on
  screen unattended.
