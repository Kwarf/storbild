# 27. Kiosk

Date: 2026-10-13

## Status

Accepted. Refines M10b's kiosk setup (ADR 0016).

## Context

The screen is a browser in full screen on a small computer next to the projector. It must
start on its own after power loss, never show browser UI or dialogs, and not change under the
show because a browser update arrived. DESIGN.md asks for `deploy/kiosk/` and for pinning or
disabling Chromium updates, but names no platform.

The screen host is behind Caddy's basic auth (DESIGN.md §8.1), so the kiosk must pass it for
the page, the SSE stream, `fetch` and the service worker.

## Decision

**Two platforms.**

- **Debian or Ubuntu** on a mini PC is the primary target.
- **Raspberry Pi OS Lite** (Pi 4 or 5) is a variant.

**Session.** A dedicated user is logged in automatically, and a systemd unit runs `cage`, a
Wayland kiosk compositor, with Chromium as its only client. There is no desktop environment.
The unit restarts on failure, and screen blanking is off.

**Chromium.**

- `deploy/kiosk/kiosk.sh` starts Chromium with the flags in DESIGN.md §7, in a dedicated
  profile, and adds `--disable-features=Translate`. It reads the screen URL from
  `/etc/storbild-kiosk.env`.
- Chromium comes from the distribution. The setup holds the package with `apt-mark hold`,
  keeps it out of unattended upgrades, and installs a managed policy that turns off component
  updates and the update check. An update is a deliberate step before the party.

**Basic auth.** The screen URL in `/etc/storbild-kiosk.env` carries the credentials
(`https://screen:<password>@screen.<domain>/`). The file is readable only by root and the kiosk
user. Chromium sends them with the first request and keeps them for the realm, so the stream,
`fetch` and the service worker are authenticated too. A sign-in typed once at setup doesn't
survive a reboot, so it is not used. This is checked on both platforms during the soak test,
including after a reboot.

## Consequences

- Both platforms are set up by script, so the docs stay short.
- A held Chromium misses security fixes during a party. That is the trade for a screen that
  doesn't change.
- If Chromium stops honouring credentials in the URL, the screen host needs another
  check, for example a Caddy allowlist for the kiosk's address, in a new ADR.
