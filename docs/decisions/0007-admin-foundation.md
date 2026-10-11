# 7. Admin foundation

Date: 2026-10-11

## Status

Accepted

## Context

M5 (DESIGN.md §9) asks for admin auth (§8.1), a Lit admin shell with the now/next strip and
an embedded preview, the Live panel and a typed `hc` client. Several things weren't settled by
the design:

- How sessions are stored, how long they last, and what the cookie looks like when
  development runs on plain http.
- What the rate limit counts per, when production requests all arrive from the local proxy.
- How the admin guards against cross-site requests beyond SameSite.
- Which admin routes need a session.
- How the admin is bundled and served, where its font comes from, and how the browser
  package gets the server's app type for `hc`.
- What "guarded" means for blackout.

## Decision

**The password hash is required.** `STORBILD_ADMIN_PASSWORD_HASH` must be set, as ADR 0002
anticipated, and the server refuses to start without it. `bun run hash-password` (the server
package's `storbild hash-password` bin) reads a password, without echo and asked twice on a
terminal, or as the first line of piped stdin, and prints an argon2id hash. Bun expands `$` in
`.env` files even inside quotes, so it also prints (on stderr) a `.env` line with each `$`
escaped as `\$`.

**Sessions.**

- A session is a random 32-byte token in the cookie. The `sessions` table (`STRICT`) stores
  only its SHA-256 and expiry, so a copy of the database can't be used to log in.
- A session expires 7 days after it was last used. Using it pushes the expiry back, but at
  most once an hour, and then the cookie's `Max-Age` is renewed too. Expired rows are deleted
  at the next login.
- The cookie is HttpOnly, SameSite=Lax, `Path=/`, with no `Domain`. When `STORBILD_ADMIN_URL`
  is https it is also Secure and named `__Host-storbild_session`; the prefix makes the
  browser enforce a host-only cookie. On plain http (development) it is `storbild_session`
  without Secure, which a browser would otherwise drop.
- Sessions survive restarts.

**Login.** `GET /login` is a server-rendered form, styled with the same tokens as the shell, so
it works before any script loads. `POST /login` takes the form, and `POST /logout` ends the
session. The username is compared in constant time and the password is always verified, so
response time doesn't reveal a valid username.

**Rate limit.** In memory, per client: after 5 failures in 5 minutes, logins are refused with
`429` and `Retry-After` until the window ends. A success clears the count. The client is the
socket address, or the first `X-Forwarded-For` hop when the socket is loopback, which is the
local Caddy. Counting per client means an attacker can't lock the crew out. The limiter
resets on restart.

**Origin check.** Every request other than GET, HEAD and OPTIONS must carry an `Origin` equal
to the admin's public origin or the request's own, or it gets `403`. Browsers always send
`Origin` on such requests. Scripts calling the API must set it.

**What needs a session.** Everything under `/api/` (commands, events, the new `/api/time`,
plugin routes) answers `401` without one. Shell pages redirect to `/login`. The bundle,
fonts, `/vendor`, `/plugins` and `/importmap.json` stay public: they hold no show data, and
the viewer app already serves the same files publicly. A plugin route meant for an external
webhook therefore needs a session too, until a later milestone decides otherwise.

**Bundle and page.** The viewer's build-and-serve code becomes a shared `buildApp`. The admin
bundle (`@storbild/admin/main`) is built once per process and served immutably at
`/app/<hash>/…`. `lit`, `zod` and the SDK stay external through the import map, so the preview
shares one Lit with plugin modules. The shell is served at `/` and at every section path
(`/live`, `/rotation`, …) for history routing, `no-store`. Page HTML lives in
`@storbild/admin` (its root export, server-side), next to the tokens it uses.

**Font.** Instrument Sans, latin, weights 400 and 600, from `@fontsource/instrument-sans`. The
woff2 files are added to the admin bundle under `fonts/`, so they share its hash and immutable
caching. The admin needs no Google Fonts at the venue.

**Typed client.** `api.ts` uses `hc<AdminApp>` with a type-only import of the server's app
type. For that to typecheck, the admin's `tsconfig.json` includes Bun types. A Biome rule
forbids importing `bun`, `node:*` and `@storbild/server` in the admin's browser code. Biome
can't exempt type-only imports, so the one type import carries a `biome-ignore`.

**Reuse of the viewer.** The admin follows the show over `/api/events` with the viewer's
`SyncClient`, and estimates server time with `ClockSync` against `/api/time`. The strip's
preview is `<sb-stage><sb-compositor>` fed the same state, so there's no second stream, and
the preview switches on time just like a screen. When a stream or API call gets `401`, the
admin goes to the login page.

**The shell.**

- The sidebar lists all §8.2 sections. Pages that arrive later say which milestone brings
  them.
- The strip shows the preview, what is on air with the time left, what is next and when, the
  visible overlays, and an auto/override indicator (Rotation, Take, Interrupt, Blackout) with
  when it returns to the rotation. Each is derived with `resolveTimeline` at `serverNow()`.
- Light and dark follow the system unless the operator picks one. The choice is remembered
  in `localStorage` and applied before first paint.

**Live panel.** Announce picks an existing scene instance and sends `live.interrupt`, with an
optional duration (blank holds until dismissed) and dim on by default. Take now sends
`live.take`. Resume rotation (`live.resume`) and Dismiss (`live.clearInterrupt`) appear
while they apply. Broken instances are listed but can't be picked. Blackout must be held for
1.5 s, by pointer or Space/Enter, with a fill showing progress; ending it is one click.
Refused commands show their message next to the control.

## Consequences

- Every API client, including tests, logs in and sends `Origin`. The test helpers
  `testConfig` and `adminHeaders` do this.
- Development needs `.env` with a hash before `bun run dev` starts.
- The admin package depends on the server package's types, and the server on the admin's
  bundle and page helpers. The cycle is type-only in one direction.
- `bun run dev` doesn't rebuild the admin bundle when its sources change; restart.
- Deferred:
  - quick announce from a typed message (M6, needs the announcement plugin)
  - the other admin pages (M6–M8)
  - a connected-screens count
  - public webhook routes for plugins
