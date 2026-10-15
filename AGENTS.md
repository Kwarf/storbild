# AGENTS.md

This file provides guidance to coding agents working with code in this repository.

## Project status

Storbild is plugin-based big-screen ("beamer") software for demoparties. M0–M9 are in place (foundation, core state and sync, plugin host, viewer, scheduler, admin foundation, admin forms and content pages, M6b's assets, schedule and quick announce, theming, overlays, and the built-in plugins; M6 was split in [ADR 0009](docs/decisions/0009-split-m6.md), and `now-playing` will be an external plugin, [ADR 0015](docs/decisions/0015-built-in-plugins.md)). M10 is split into M10a (resilience and show portability) and M10b (operations and release) in [ADR 0016](docs/decisions/0016-split-m10.md); M10a is in place ([ADR 0019](docs/decisions/0019-resilience-and-show-files.md)). M10b's code and docs are in place (plugin reload, the published SDK and the plugin template, the deployment files, the kiosk setup, [ADRs 0025–0027](docs/decisions/)); what remains is setting up a fresh VPS and kiosk from the docs and the soak test ([docs/soak-test.md](docs/soak-test.md)). [DESIGN.md](DESIGN.md) is the source of truth for architecture, scope and milestones (M0–M10b). Read the relevant sections of DESIGN.md before starting any work, and keep scope to one milestone at a time.

The dev container (`.devcontainer/`) provides Node 22 + Bun. Ports 3000 (viewer) and 3001 (admin) are forwarded.

## Commands

- `bun install`
- `bun run dev` — starts both Hono apps (viewer :3000, admin :3001) with watch mode. Config comes from `STORBILD_*` env vars or `.env`; see `.env.example`. `STORBILD_ADMIN_PASSWORD_HASH` is required
- `bun run hash-password` — prints an argon2id hash for `STORBILD_ADMIN_PASSWORD_HASH`
- `bun test` — single file: `bun test path/to/file.test.ts`; single test: `bun test -t "name pattern"`
- `STORBILD_E2E=1 bun test packages/server/e2e` — viewer and admin e2e tests in Chromium via Playwright (skipped without the env var). Install the browser once with `bunx playwright install chromium` in `packages/server`. The admin test writes light/dark screenshots to `packages/server/e2e/screenshots/` for design review
- `bun run demo` — seeds a fictional party show on a frozen clock and writes the README screenshots to `docs/screenshots/` (`bun run demo <name>…` for some, `--serve` to keep the demo running on :3000/:3001). The show is in `packages/server/demo/show.ts`, the shots in `shots.ts`; needs the Playwright Chromium like the e2e tests
- `STORBILD_PACK=1 bun test packages/server/src/sdk-package.test.ts` — the pack test: builds and packs the SDK, installs it into a copy of `templates/plugin/`, type checks and tests that, and loads it in the host (needs the network). `bun run build` in `packages/plugin-sdk` writes the publishable `dist/` ([ADR 0026](docs/decisions/0026-sdk-publishing-and-plugin-template.md))
- `bun run typecheck` — `tsc --noEmit` in every workspace (each package has its own `tsconfig.json`; the server's also covers `deploy/*.ts`)
- `bun run lint` (Biome check), `bun run format` (Biome format). CI runs `bunx biome ci .`

CI is a GitHub Actions workflow in `.github/workflows/ci.yml` ([ADR 0022](docs/decisions/0022-move-to-github.md)): checks and tests, the pack test, and an image build that must turn healthy. `.github/workflows/release.yml` publishes on pushed tags: `v<version>` pushes the image to `ghcr.io/kwarf/storbild`, and `sdk-v<version>` publishes `@storbild/plugin-sdk` to npm with trusted publishing, with no token (the tag must match its `package.json` version). When the SDK's version changes, update `templates/plugin/package.json` and the `peerDependencies` example in `docs/plugin-authoring.md` to match in the same commit; the pack test installs the local SDK, so CI won't catch a stale pin. Two changelogs record changes for the people they affect ([ADR 0029](docs/decisions/0029-changelogs.md)): `CHANGELOG.md` for those who run Storbild (features, behaviour, configuration, deployment; **Upgrading** steps when they must act), and `packages/plugin-sdk/CHANGELOG.md` for plugin authors (the SDK, and what the host does around plugins, such as how the compositor draws widgets; **Action needed** steps when plugins should change). Add an entry under `## Unreleased` in each one a change affects. A release bumps the version (`packages/server/package.json` for `v<version>`, `packages/plugin-sdk/package.json` for `sdk-v<version>`) and renames that changelog's Unreleased section to `## <version> — <date>` in the same commit; `scripts/changelog.test.ts` fails when a version has no notes, the release job checks the tag against the version, and the notes become the GitHub release. The Bun version is pinned in `.bun-version`, and `deploy/Containerfile`'s `BUN_VERSION` must match it.

Some rules below are enforced by tooling ([ADR 0002](docs/decisions/0002-configuration-and-tooling.md)): `packages/core` has no DOM, Bun or Node types, so timers and I/O fail typecheck, and Biome's `noRestrictedImports` blocks forbidden imports in `packages/core` and `plugins/`. New packages need a `typecheck` script and a `tsconfig.json` that extends `tsconfig.base.json`.

## Architecture in brief

Bun workspace monorepo (DESIGN.md §3): `packages/core` (pure shared logic), `packages/plugin-sdk` (public `@storbild/plugin-sdk`), `packages/server` (Bun + Hono), `packages/viewer` (Lit), `packages/admin` (Lit), and built-in plugins under `plugins/`.

- **One process, two Hono apps on two ports.** Viewer app (:3000: viewer page, `/events` SSE, `/time`) and admin app (:3001: login, `/api/commands`, `/api/events`). Keep viewer routes and admin routes on their own apps so the screen hostname can never reach admin routes. Everything under `/api/` needs a session cookie, and non-GET requests need a matching `Origin`; tests use `testConfig` and `adminHeaders` from `packages/server/src/testing.ts` ([ADR 0007](docs/decisions/0007-admin-foundation.md)).
- **Server is the only writer.** Every change is a Zod-validated command (`POST /api/commands`), applied by a reducer, which bumps `revision`, persists to SQLite and broadcasts an RFC 6902 JSON Patch over SSE. Clients never mutate state directly.
- **Viewers render from state, on the client.** SSE sends a snapshot and then patches. `Last-Event-ID` resumes from a ring buffer, and the server falls back to a snapshot when the buffer has rolled past.
- **Time-based, not tick-based.** State carries absolute server-time start/end times. `resolveTimeline(state, t)` in `packages/core` is a pure function used by both the server (authoritative) and the viewer (to keep running through outages). Resolved durations are computed on the server and stored in state, so the viewer never needs plugin server code. The server's `Scheduler` arms one timer for the next boundary and calls `settle` in core (durations, re-anchoring, cues, timeline); take/interrupt/blackout are the `live` input ([ADR 0006](docs/decisions/0006-scheduler-and-timeline.md)).
- **Viewer** (`packages/viewer`): `SyncClient` (SSE + watchdog), `ClockSync`, and `<sb-compositor>` with one `SceneLayer` per scene layer. The server bundles `@storbild/viewer/main` and serves it at `/app/<hash>/`, with lit/zod/SDK from the import map ([ADR 0005](docs/decisions/0005-viewer.md)). The compositor renders `resolveTimeline(state, serverNow())` itself and re-resolves at the next boundary.
- **Plugins** (`definePlugin`) contribute instance types (`scene` or `overlay`), each with a Zod config schema. Each plugin has three faces: Lit viewer elements, admin forms generated via `z.toJSONSchema()` (or a custom editor), and an optional in-process server part. A plugin package's `exports["."]` is its definition (server only), `package.json` `storbild.viewer` names its browser entry, and the optional `storbild.admin` registers custom editors. The SDK has matching subpaths: `@storbild/plugin-sdk` (no DOM; includes the `fields` widget helpers), `/viewer` (Lit), `/admin` (`<sb-form>`, `<sb-field>`) and `/build`. The admin gets the schemas from `GET /api/schemas` ([ADR 0010](docs/decisions/0010-admin-forms-and-content-pages.md)). The host (`packages/server/src/plugins/`) bundles both faces with `Bun.build`, mapping `lit`, `zod` and the SDK to its own copies; in the browser they resolve through `/importmap.json`. Plugin modules are served at `/plugins/<id>/<version>/<hash>/…`, where the hash covers the built files ([ADR 0004](docs/decisions/0004-plugin-sdk-and-host.md), [ADR 0025](docs/decisions/0025-plugin-reload.md)). With `STORBILD_PLUGIN_WATCH=1`, `plugins/watch.ts` reloads a plugin from `STORBILD_PLUGIN_PATHS` when its files change. A plugin's own dependencies (such as `marked` or `uqr`) are bundled into its modules; pin exact versions ([ADR 0015](docs/decisions/0015-built-in-plugins.md)).
- **Admin** (`packages/admin`): a Lit shell (`<sb-admin>`) bundled and served like the viewer, at `/app/<hash>/` with fonts inside. It reuses the viewer's `SyncClient`, `ClockSync` and `<sb-compositor>` (for the preview) on `/api/events` and `/api/time`, and calls commands through `hc<AdminApp>`. Show-wide defaults (default duration, transition length) are `ShowState.settings`, set with `settings.update`. Its root export (`src/server.ts`) holds server-side page HTML and tokens. Browser code may import the server only with `import type` ([ADR 0007](docs/decisions/0007-admin-foundation.md)).
- **Assets** are uploaded with `POST /api/assets?name=…` (the raw body, streamed to disk; the thumbnail follows with `PUT /api/assets/<id>/thumbnail`), stored in the data directory under their SHA-256 (videos have their own size limit), and served immutably at `/assets/<hash>` on both apps. The type is sniffed from the content (`packages/server/src/sniff.ts`, with file-type and image-size, [ADR 0021](docs/decisions/0021-file-type-and-image-size-for-sniffing.md)), and the admin makes the thumbnails. Plugins refer to a file by ID with `fields.asset()`, and `<sb-field>` renders the SDK's asset picker, which gets the files from the admin shell through an `sb-asset-source` event. An asset in use can't be deleted (`assetUsers` in core) ([ADR 0011](docs/decisions/0011-assets-schedule-and-quick-announce.md)).
- **Compositor owns layers and transitions.** Layers from bottom to top: theme background, main scene, overlay slots, interrupt, blackout. Scenes are transparent by default and don't implement transitions. Overlay widgets sit in a slot grid inside the safe area (`OverlayLayer` in `packages/viewer`); they fade out for slots that the scene on air or the interrupt reserves (`reservedSlots` in core) and when their `staleAt()` passes ([ADR 0012](docs/decisions/0012-overlays.md)).
- **Offline and show files** ([ADR 0019](docs/decisions/0019-resilience-and-show-files.md)). The viewer app serves a service worker at `/sw.js` (`packages/viewer/src/sw.ts`, strategies in `offline.ts`). The server prepends a manifest of the page, bundle, vendor and plugin URLs, and the page tells the worker which assets to cache (`referencedAssetIds` in core). The viewer stores its last state and clock offset in `localStorage`, starts from them if no snapshot arrives within 3 s, and shows an offline pill after 10 s out of touch. A show file is one zip made and read by `packages/server/src/zip.ts`, a thin layer over zip.js ([ADR 0020](docs/decisions/0020-zip-js-for-show-files.md)); `GET /api/show/export` and `POST /api/show/import` replace the whole show through the host-only `show.import` (`importShow` in core).
- **Themes** reach plugins only as CSS variables on the compositor (`themeVariables` in `packages/viewer/src/theme.ts`). The compositor applies a theme once its uploaded fonts have loaded (FontFace API, one `sbf-<hash>` family per set of files). `BackgroundLayer` draws the theme background. It fades out when the scene on air has its own (`sceneBackground` in core). An interrupt's `hide` cover fades the scene and overlays out instead of drawing the background twice ([ADR 0014](docs/decisions/0014-theming.md)).

## Rules that must not be broken

- `packages/core` has **no I/O and no timers**. Inject time so it stays unit-testable.
- Built-in plugins import **only** `@storbild/plugin-sdk` (plus their own deps). If one needs internals, extend the SDK instead.
- Viewer and plugin code use `serverNow()` for anything schedule-related, never `Date.now()`.
- All schemas are Zod (v4) in `packages/core`, and TS types are inferred from them.
- SQLite tables are created with `STRICT`. JSON columns are `TEXT` with `CHECK (json_valid(col))`.
- Broken instances and incompatible or failing plugins are reported (status, admin flag) and skipped. They must never crash the host or the show.
- The SDK is a public API. Keep its surface small, and bump `apiVersion` and the SDK major version on breaking changes.
- TypeScript `strict` everywhere.

## Workflow conventions (DESIGN.md §10)

- Before implementing a milestone, write a short plan (tasks and open questions).
- Any change or refinement to the design goes in an ADR at `docs/decisions/NNNN-title.md` (context, decision, consequences), and DESIGN.md is updated to match.
- Each milestone adds tests for its acceptance criteria. Prefer boundary tests (the SSE stream, commands, `resolveTimeline`) over internal unit tests.
- Admin visual design follows DESIGN.md §8.3: no Inter/Geist, rows over cards, no shadows/gradients/emoji, `tabular-nums` for times.

## Commits

Commits containing code written with an agent's help end with this trailer, in place of `Co-Authored-By`:

```
Assisted-by: AGENT_NAME:MODEL_VERSION
```

For example: `Assisted-by: Claude:claude-opus-5-5`.
