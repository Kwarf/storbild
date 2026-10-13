# @storbild/plugin-sdk

The SDK for writing plugins for [Storbild](https://github.com/Kwarf/storbild), plugin-based
big-screen software for demoparties. A plugin adds scene and overlay types to the screen, with
a config schema that the admin turns into a form.

```sh
bun add -d @storbild/plugin-sdk lit zod
```

| Import | For |
|---|---|
| `@storbild/plugin-sdk` | `definePlugin`, `z`, `fields`, `API_VERSION`, server part types. No DOM |
| `@storbild/plugin-sdk/viewer` | `StorbildScene` and `StorbildOverlay`, the Lit base classes for the screen |
| `@storbild/plugin-sdk/admin` | `<sb-form>` and `<sb-field>`, for custom admin editors |
| `@storbild/plugin-sdk/build` | `buildPlugin` and `pluginExternals`, for shipping built ESM. Needs Bun |

`lit`, `zod` and the SDK are provided by the host when a plugin runs, so keep them out of
your bundle. The SDK's major version follows the plugin API version (`apiVersion`).

Start from the template in
[`templates/plugin/`](https://github.com/Kwarf/storbild/tree/main/templates/plugin), and read
the [plugin authoring guide](https://github.com/Kwarf/storbild/blob/main/docs/plugin-authoring.md).

MIT licensed.
