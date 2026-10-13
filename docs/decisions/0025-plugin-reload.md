# 25. Plugin reload

Date: 2026-10-13

## Status

Accepted. Specifies the dev-mode reload deferred by ADR 0004 and ADR 0016.

## Context

DESIGN.md §6.3 says the host reloads a plugin from `STORBILD_PLUGIN_PATHS` when it changes.
Today the host loads plugins once at boot, and the catalog, the module registry, the schemas,
the runtime and the service worker manifest are all fixed from then on.

Module URLs are `/plugins/<id>/<version>/…` and served as immutable. A plugin author edits
code without bumping the version, so a rebuilt module would be served at the URL of the old
one, and browsers and the service worker would keep the old code. The same happens in
production when a plugin is rebuilt without a version bump.

Rebuilding plugins behind a running show is useful while writing one, and a risk at a party.

## Decision

**Opt-in.** `STORBILD_PLUGIN_WATCH=1` turns reloading on. It watches only the directories in
`STORBILD_PLUGIN_PATHS`, never the built-in plugins. It is off by default.

**Module URLs carry a content hash.** Every plugin's browser modules are served at
`/plugins/<id>/<version>/<hash>/…`, where the hash covers all of its built viewer and admin
files. This applies with and without watching, so there is one code path. A changed build
gets a new URL, and an unchanged one keeps its URL, so a restart with unchanged plugins still
produces no new revision (ADR 0004). A stale version or hash is a 404.

**Reloading a plugin.**

- The host watches each plugin directory recursively, ignoring `node_modules`, `.git` and
  dotfiles, and reloads a directory about 200 ms after its last change. Reloads run one at a
  time.
- It loads the plugin as at boot, so a broken edit is reported as `error` and never stops the
  host or the show.
- The new catalog goes to the state hub, and `reconcilePlugins` applies it as one revision.
- The plugin's server part is stopped and the new one started, with the same isolation and
  backoff as before.
- The module registry, `/api/schemas` and the service worker manifest are updated.
- A changed ID, or a collision with an already loaded plugin, follows the boot rules: the
  first plugin with an ID wins, and the rest are logged.

**Clients.** The viewer and the admin already reload the page when a plugin in use has a new
module URL, because custom elements can't be redefined. The admin also fetches the schemas
again when a plugin's version, module or status changes.

## Consequences

- An author can run the host against their plugin and see edits on the screen without a
  restart.
- Plugin module URLs change shape. The URL is stored in state, so the first boot after the
  upgrade produces one revision.
- A plugin rebuilt without a version bump is now picked up correctly in production too.
- Removing a plugin directory while watching marks the plugin `error`; restarting without it
  makes it `missing` as before.
