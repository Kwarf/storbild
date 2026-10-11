# AGENTS.md

This file provides guidance to coding agents working with code in this repository.

## Project status

Storbild is plugin-based big-screen ("beamer") software for demoparties. M0 (repository foundation) is in place; the packages are skeletons. [DESIGN.md](DESIGN.md) is the source of truth for architecture, scope and milestones (M0–M10). Read the relevant sections of DESIGN.md before starting any work, and keep scope to one milestone at a time.

The dev container (`.devcontainer/`) provides Node 22 + Bun. Ports 3000 (viewer) and 3001 (admin) are forwarded.

## Commands

- `bun install`
- `bun run dev` — starts both Hono apps (viewer :3000, admin :3001) with watch mode. Config comes from `STORBILD_*` env vars or `.env`; see `.env.example`
- `bun test` — single file: `bun test path/to/file.test.ts`; single test: `bun test -t "name pattern"`
- `bun run typecheck` — `tsc --noEmit` in every workspace (each package has its own `tsconfig.json`)
- `bun run lint` (Biome check), `bun run format` (Biome format). CI runs `bunx biome ci .`

CI is a GitHub-style workflow in `.github/workflows/ci.yml`, currently run by Forgejo Actions (runner label `ubuntu-latest`). Keep it portable to GitHub Actions. The Bun version is pinned in `.bun-version`.

Some rules below are enforced by tooling ([ADR 0002](docs/decisions/0002-configuration-and-tooling.md)): `packages/core` has no DOM, Bun or Node types, so timers and I/O fail typecheck, and Biome's `noRestrictedImports` blocks forbidden imports in `packages/core` and `plugins/`. New packages need a `typecheck` script and a `tsconfig.json` that extends `tsconfig.base.json`.

## Architecture in brief

Bun workspace monorepo (DESIGN.md §3): `packages/core` (pure shared logic), `packages/plugin-sdk` (public `@storbild/plugin-sdk`), `packages/server` (Bun + Hono), `packages/viewer` (Lit), `packages/admin` (Lit), and built-in plugins under `plugins/`.

- **One process, two Hono apps on two ports.** Viewer app (:3000: viewer page, `/events` SSE, `/time`) and admin app (:3001: login, `/api/commands`, `/api/events`). Keep viewer routes and admin routes on their own apps so the screen hostname can never reach admin routes.
- **Server is the only writer.** Every change is a Zod-validated command (`POST /api/commands`), applied by a reducer, which bumps `revision`, persists to SQLite and broadcasts an RFC 6902 JSON Patch over SSE. Clients never mutate state directly.
- **Viewers render from state, on the client.** SSE sends a snapshot and then patches. `Last-Event-ID` resumes from a ring buffer, and the server falls back to a snapshot when the buffer has rolled past.
- **Time-based, not tick-based.** State carries absolute server-time start/end times. `resolveTimeline(state, t)` in `packages/core` is a pure function used by both the server (authoritative) and the viewer (to keep running through outages). Resolved durations are computed on the server and stored in state, so the viewer never needs plugin server code.
- **Plugins** (`definePlugin`) contribute instance types (`scene` or `overlay`), each with a Zod config schema. Each plugin has three faces: Lit viewer elements, admin forms generated via `z.toJSONSchema()` (or a custom editor), and an optional in-process server part. In the browser, `lit` and the SDK are resolved through a host-generated import map. Plugin modules are served at `/plugins/<id>/<version>/…`.
- **Compositor owns layers and transitions.** Layers from bottom to top: theme background, main scene, overlay slots, interrupt, blackout. Scenes are transparent by default and don't implement transitions.

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
