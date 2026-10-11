# 4. Plugin SDK and plugin host

Date: 2026-10-11

## Status

Accepted

## Context

M2 (DESIGN.md §9) asks for the public `@storbild/plugin-sdk`, a host that discovers, validates
and runs plugins, versioned module serving with an import map, and plugin-aware commands.
DESIGN.md §6 describes the authoring model but leaves several mechanics open: how a plugin
package is laid out, how server code and browser code are kept apart, how a plugin outside the
repository gets the host's copy of the SDK, where plugin metadata lives in state, and how
broken plugins and instances are represented.

## Decision

**Package shape.** A plugin is a directory with a `package.json`:

- `exports["."]` (or `main`) is the **definition module**, whose default export is
  `definePlugin(...)`. Only the server loads it, so the inline `server(ctx)` and its
  dependencies never reach the browser.
- `"storbild": { "viewer": "./src/viewer.ts" }` is the optional **browser entry**, which
  registers the plugin's custom elements.

The browser never imports the definition. What the viewer needs about each type comes through
state.

**SDK subpaths.** These keep Lit out of the server:

- `@storbild/plugin-sdk` has `definePlugin`, `z`, `API_VERSION`, the `ServerContext` types and
  the helper types `PluginConfig<typeof plugin, "type">` and `PluginSettings<typeof plugin>`.
- `@storbild/plugin-sdk/viewer` has `StorbildScene`, `StorbildOverlay` and `ViewerContext`.
- `@storbild/plugin-sdk/build` has `pluginExternals` and `buildPlugin()` for authors.

The SDK imports schemas and types from `@storbild/core`. Publishing it (M10) bundles core in.

**The host bundles both faces of a plugin with `Bun.build`.**

- The definition module is bundled for Bun. A resolver plugin maps `@storbild/plugin-sdk`,
  `lit` and `zod` to the host's own files, and the output is written to
  `<data dir>/cache/plugins/` and imported. This gives every plugin, including one outside the
  repository with no `node_modules`, the host's single copy of Zod and the SDK. That matters
  because plugin schemas are checked with `instanceof z.ZodType`.
- Bun's runtime resolver hooks do not apply to bare imports inside a dynamically imported
  module, and Bun would auto-install a second Zod instead. That is why plugins are bundled
  rather than imported directly.
- The viewer entry is bundled for the browser with `pluginExternals` left external, and served
  from memory. Built-in plugins need no build step. A third-party plugin may ship TypeScript
  or built ESM, and both work.

**Serving.** One route group is mounted on both apps, because the admin needs the modules for
preview and custom editors later:

- `/plugins/<id>/<version>/…` serves a plugin's bundled viewer module.
- `/vendor/<hash>/…` serves lit (every export entry point, built together so there is one
  lit-html), Zod and the two browser SDK subpaths.

Both are immutable, and a stale version or hash is a 404. `/importmap.json` (`no-store`) maps
each bare specifier to its vendor URL. M3 inlines it into the viewer page.

**State.** The plugin entry in `ShowState` carries the host's view:

- `version`, `status`, `error?`, and `module?` (the viewer module URL)
- `types`: per type, `kind`, `label`, `viewer`, and the optional `editor`, `background`,
  `reserveSlots`, `hideOverlays` and `singleton`

This is DESIGN.md's derived `pluginModules` map, folded into the plugin entry. Status gains
`missing`, for a plugin whose data is stored but which is no longer installed; its settings and
state are kept. An `Instance` gains `error?`, which the host sets when the instance is broken.

**The whole plugin entry is persisted**, in a new `info` column, refining ADR 0003, which
stored only settings and state. The host still recomputes the entry on every load. Storing it
means a restart with unchanged plugins produces no new revision, while a restart that changes
something (a plugin upgraded, removed or newly broken) produces exactly one. A viewer that
resumes at the stored revision therefore always receives the change.

**A pure catalog in core.**

- The host turns loaded plugins into a `PluginCatalog`: per plugin, its status, settings schema
  and, per type, the config schema, `configVersion` (default 1) and `migrate`.
- The reducer receives the catalog in `CommandContext`, so `applyCommand` stays pure.
- `normalizeConfig` migrates and then validates a config. `reconcilePlugins` rebuilds plugin
  entries, applies settings defaults, and migrates or flags every instance.
- Plugin code (`migrate`, schema refinements) runs inside try/catch, and a throw counts as
  invalid. Stored configs and settings are the schema's parsed output, so defaults are
  materialised, and that output must be JSON.

**Commands.**

- `instance.create` and `instance.update`, when the config changes:
  - An unknown plugin or type returns `404`.
  - An unavailable plugin, an invalid config or a failed migration returns `422`, with
    `issues` (`{ path, message }[]`) in the body.
  - An older `configVersion` in the payload is migrated.
- `plugin.updateSettings` replaces the settings whole and validates them the same way.
- Renaming a broken instance is allowed. Changing its config re-validates it and clears
  `error`.
- `plugin.setState`, `plugin.setStatus` and `instance.setState` are **host commands**. They are
  in a separate `hostCommandSchema` that `POST /api/commands` never accepts. They go through the
  same reducer, persistence and broadcast, and are dropped when they change nothing.

**Loading never fails the host.**

- The host checks `apiVersion` first. A mismatch is `incompatible`.
- Next it validates the definition with `pluginDefinitionSchema`: ID, semver version, element
  names, at least one type. It then checks that every settings and config schema converts with
  `z.toJSONSchema(…, { io: "input" })`, because admin forms are generated from it.
- An import error, an invalid definition, a non-convertible schema or a failing viewer build is
  `error`, reported under the declared ID (or the directory name).
- Of two plugins with the same ID, the first wins and the second is logged.
- Built-ins (`plugins/*`) load before `STORBILD_PLUGIN_PATHS`. If `package.json` and the
  definition disagree on the version, the definition wins and the mismatch is logged.

**Server parts.**

- The runtime runs each `server(ctx)` with its own `AbortSignal`.
- A throw or rejection from `server()` or a listener sets `status: "error"` and restarts the
  part with exponential backoff (1 s doubling to 60 s). A settings change resets the backoff.
- Invalid settings (for example after an upgrade adds a required field) stop the part and set
  `error` until `plugin.updateSettings` fixes them.
- Listeners and the route handler are dropped on abort, and state writes after abort are
  ignored.
- The runtime watches the hub in a microtask after each revision, so a dispatch from a
  listener never reorders other streams' patches. It calls `onSettingsChange` and
  `onInstancesChange` only when the plugin's settings or instances actually changed.
- `main` logs uncaught exceptions and unhandled rejections instead of exiting, because plugin
  timers run in-process.

**`ctx.route` takes a fetch handler**, `(request: Request) => Response | Promise<Response>`,
rather than a Hono app. That keeps Hono out of the public SDK. The handler serves
`/api/plugins/<id>/*` on the admin app only, and sees paths relative to that prefix.

## Consequences

- Third-party plugins need nothing but the SDK and its peers. For type checking before the SDK
  is published (M10), they link `@storbild/plugin-sdk` and `lit`. They also need
  `allowImportingTsExtensions`, because the SDK still ships TypeScript sources. The M2
  acceptance test does exactly this from a temporary directory outside the repository.
- Every boot builds the vendor modules and each plugin's modules (tens of milliseconds) and
  writes the definition bundles into the data directory's cache.
- A plugin that is uninstalled stays in state as `missing`, with its instances broken, until
  it is reinstalled. Removing it for good needs a command, which the admin plugins page (M6)
  can add.
- Plugin routes are on the admin app, so the M5 session will cover them. Webhooks that cannot
  log in will need a way around that, to be decided in M5.
- Deferred:
  - reloading plugins from `STORBILD_PLUGIN_PATHS` when they change (M10)
  - a JSON Schema endpoint and generated forms (M6)
  - evaluating `duration()` (M4)
  - stale-hide in `StorbildOverlay` (M8)
  - theme access in `ViewerContext` (M7)
