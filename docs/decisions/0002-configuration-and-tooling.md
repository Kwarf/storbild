# 2. Configuration and repository tooling

Date: 2026-10-11

## Status

Accepted

## Context

M0 (DESIGN.md §9) asks for config loading from the environment, strict TypeScript, Biome and
CI, but leaves the details open. Several architecture rules (a pure `packages/core`, plugins
that use only the public SDK) are easy to break by accident and are better enforced by tools
than by review.

## Decision

**Configuration.** All settings come from `STORBILD_*` environment variables (Bun also reads
`.env`). `.env.example` documents them:

| Variable | Default |
|---|---|
| `STORBILD_HOST` | `127.0.0.1` |
| `STORBILD_VIEWER_PORT` | `3000` |
| `STORBILD_ADMIN_PORT` | `3001` |
| `STORBILD_DATA_DIR` | `./data` |
| `STORBILD_ADMIN_USERNAME` | `admin` |
| `STORBILD_ADMIN_PASSWORD_HASH` | unset (required from M5) |
| `STORBILD_PLUGIN_PATHS` | empty, OS path delimiter |
| `STORBILD_VIEWER_URL` / `STORBILD_ADMIN_URL` | `http://localhost:3000` / `:3001` |

The Zod schema and `parseConfig(env, delimiter)` live in `packages/core`. They are pure and
take the environment as an argument. The server wraps them, passing `process.env` and
resolving paths. Both apps bind to loopback by default, because production runs behind Caddy.

**TypeScript.** There is no build step for internal packages: they export `src/*.ts` directly.
Each package has its own `tsconfig.json` extending `tsconfig.base.json`, and these set the
available globals:

- `packages/core` gets `lib: ["ES2023"]` and no ambient types, so timers, `fetch` and `Bun.*`
  do not typecheck there. Its tests are checked separately with Bun types.
- `packages/server` gets Bun types.
- Browser packages get the DOM lib.

`bun run typecheck` runs `tsc --noEmit` in every workspace.

**Lint rules for architecture.** Biome's `noRestrictedImports` forbids:

- runtime modules (`bun`, `node:*`, `hono`) and other workspace packages in
  `packages/core` (tests excepted)
- any `@storbild/*` package except `@storbild/plugin-sdk`, and any path into
  `packages/`, in `plugins/`

**CI.** The project is hosted on Forgejo for now and may move to GitHub. CI is a GitHub Actions
workflow at `.github/workflows/ci.yml`, which Forgejo also runs when there is no
`.forgejo/workflows/`. It runs `typecheck`, `biome ci` and `bun test`. The Bun version is pinned
in `.bun-version`. To keep the file portable:

- It uses `runs-on: ubuntu-latest`. The Forgejo runner is registered with that label, mapped to
  a Docker image that includes Node (JavaScript actions need it).
- `uses:` refers to actions by short GitHub names. Forgejo resolves these through
  `DEFAULT_ACTIONS_URL`, which must point to `https://github.com`. Full URLs in `uses:` are not
  used, because GitHub doesn't accept them.

## Consequences

- Breaking the core purity or SDK-only rule fails typecheck or lint, not just review.
- The type-level check can't catch everything (`Date.now()` is part of ES2023), so injected
  time remains a convention, backed by tests.
- Moving to GitHub needs no workflow changes. Forgejo-only workflow features must not be used.
- Publishing `@storbild/plugin-sdk` (M10) will need a build step for that package.
