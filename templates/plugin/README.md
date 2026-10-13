# Storbild plugin template

A minimal [Storbild](https://github.com/Kwarf/storbild) plugin with one scene type, `greeting`:
a message in the theme's type, with the time of day below it. Copy this folder to start a
plugin, then read the [plugin authoring guide](../../docs/plugin-authoring.md).

```sh
bun install
bun run typecheck
bun test
```

| File | |
|---|---|
| `src/plugin.ts` | The definition: ID, version, the `greeting` type and its config schema |
| `src/viewer.ts` | `<hello-greeting>`, the element the screen renders |
| `src/plugin.test.ts` | Tests for the config schema |

To see it on a screen, run Storbild from a checkout with this folder on the plugin path:

```sh
STORBILD_PLUGIN_PATHS=/path/to/this/folder STORBILD_PLUGIN_WATCH=1 bun run dev
```

Then create a Greeting in the admin's Library and add it to the rotation. With
`STORBILD_PLUGIN_WATCH=1`, every save reloads the plugin.

Before you publish or install it anywhere, rename it: `name` in `package.json`, and the `id`
and the element names in `src/`.
