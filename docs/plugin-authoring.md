# Writing a Storbild plugin

Everything on the big screen comes from a plugin: the built-in Markdown, slideshow, countdown,
announcement and info plugins use the same public SDK as yours will. This guide covers what
a plugin is, how to start one from the template, and how to run it at a party.

You need Bun (the version in [`.bun-version`](../.bun-version)) and a Storbild checkout or
deployment to run the plugin in.

## What a plugin is

A plugin is a package that contributes **instance types**. Each type is a `scene` (a full-screen
slide in the rotation, or an interrupt) or an `overlay` (a widget placed in a slot on top of
the scenes, such as a clock). Operators create **instances** of a type in the admin, each with
its own config.

A plugin has up to three faces:

| Face | Where it runs | What it is |
|---|---|---|
| Definition | Server | `definePlugin(...)`: the ID, the types and their Zod config schemas, optional settings and server part |
| Viewer | Browser, on the screen | Lit elements that render an instance from its config |
| Admin | Browser, in the admin | Optional custom editors; otherwise the admin generates a form from the schema |

The server is the only writer: an element never changes the show, it renders what the state
says. The compositor owns layout, layering and transitions, so a scene just fills its box.

## Start from the template

[`templates/plugin/`](../templates/plugin) is a working plugin with one scene. Copy it out of
the repository and install its dependencies:

```sh
cp -r storbild/templates/plugin my-plugin
cd my-plugin
bun install
bun run typecheck && bun test
```

Then change `name` in `package.json`, and the `id` and the element names in `src/`.

The package layout is what the host looks for:

```json
{
  "type": "module",
  "exports": { ".": "./src/plugin.ts" },
  "storbild": { "viewer": "./src/viewer.ts", "admin": "./src/admin.ts" },
  "peerDependencies": { "@storbild/plugin-sdk": "^1.1.0", "lit": "^3.3.3" }
}
```

- `exports["."]` is the definition. It runs on the server only.
- `storbild.viewer` is the browser entry that defines your viewer elements.
- `storbild.admin` is optional, for custom editors.

The host bundles all three with Bun when it loads the plugin. TypeScript sources work as they
are, so there is no build step. `lit`, `zod` and the SDK always come from the host, so the
screen loads one copy of each. Your own dependencies are bundled into your modules. Pin their
exact versions.

## The definition

```ts
import { API_VERSION, definePlugin, fields, z } from "@storbild/plugin-sdk";

export default definePlugin({
  id: "hello",
  version: "0.1.0",
  apiVersion: API_VERSION,
  settings: z.object({ signature: z.string().default("The orgas") }),
  types: {
    greeting: {
      kind: "scene",
      label: "Greeting",
      config: z.object({
        message: fields.markdown().meta({ description: "Shown in large type." }),
        showClock: z.boolean().default(true),
      }),
      viewer: "hello-greeting",
    },
  },
});
```

- **`id`** is stored with every instance, so pick it once. It is lowercase letters, digits and
  hyphens.
- **`version`** is semver. Bump it on every release.
- **`apiVersion`** is always `API_VERSION`. A host with another API version reports the plugin
  as `incompatible` and leaves it out.
- **`settings`** is one object per plugin, edited on the admin's Plugins page. Each instance
  gets its own **`config`**.

Both are Zod 4 schemas, and the admin generates their forms with `z.toJSONSchema()`. Use only
what JSON Schema can describe. A `z.date()`, for example, makes the plugin fail to load, with
the reason shown in the admin. Give fields defaults where you can. A `.meta({ description })`
becomes the help text under the field.

`fields` adds the widgets plain JSON Schema has no type for:

| Helper | Stores | Edited as |
|---|---|---|
| `fields.markdown()` | a string | a multi-line text box |
| `fields.color()` | `#rrggbb` | a colour picker |
| `fields.duration()` | milliseconds | seconds or `m:ss` |
| `fields.datetime()` | epoch ms, server time | a local date and time |
| `fields.asset({ accept: ["image/*"] })` | an asset ID | the asset picker, with uploads |

Per type, you can also set:

- **`duration(config, settings)`**: how long the scene runs in the rotation, in ms, for example
  one slide per image. Without it, the show's default duration is used.
- **`background: "own"`**: hides the theme background while the scene is on air, for a scene
  that draws its own.
- **`reserveSlots: ["bottom-right"]`** and **`hideOverlays: true`**: fade overlay widgets out
  while the scene is on air.
- **`singleton: true`**: at most one instance of the type.
- **`frame: false`**: for an overlay that draws its own shape, such as a full-width ticker. The
  compositor then draws no widget frame around it (see Overlays below).
- **`editor: "hello-greeting-editor"`**: a custom admin editor (see below).

### Changing a config schema

Instances are stored, so a release that changes a schema must still accept old configs.
Adding a field with a default is always safe. For anything else, bump `configVersion` and
upgrade old configs in `migrate`:

```ts
counter: {
  kind: "overlay",
  configVersion: 2,
  // Version 1 stored { n: "3" }.
  migrate: (fromVersion, config) => ({ count: Number((config as { n: string }).n) }),
  config: z.object({ count: z.number().int() }),
  // ...
},
```

An instance whose config doesn't validate after migration is marked broken in the admin and
skipped on the screen. Its stored config is kept, so a fixed release brings it back.

## Viewer elements

```ts
import type { PluginConfig } from "@storbild/plugin-sdk";
import { StorbildScene } from "@storbild/plugin-sdk/viewer";
import { css, html } from "lit";
import type plugin from "./plugin.ts";

type Config = PluginConfig<typeof plugin, "greeting">;

export class GreetingScene extends StorbildScene<Config> {
  static override styles = css`
    :host { display: grid; place-content: center; height: 100%;
            color: var(--sb-color-text, #fff); font-family: var(--sb-font-body, sans-serif); }
  `;
  override render() {
    return html`<p>${this.config.message}</p>`;
  }
}

customElements.define("hello-greeting", GreetingScene);
```

Scenes extend `StorbildScene`, and overlays extend `StorbildOverlay`. The compositor sets these
properties:

- `config` and `settings`: the instance's config and the plugin's settings, already
  validated.
- `state` and `pluginState`: runtime data from your server part, if you have one.
- `ctx`: `serverNow()` and `assetUrl(id)`.
- `visible`: whether the element can be seen (below).

Lit re-renders when any of them changes.

The canvas is a fixed 1920×1080, scaled to the screen, so use pixel sizes freely. Scenes are
transparent, and the theme background shows through.

**Time.** Use `this.ctx.serverNow()` for anything you show or schedule, never `Date.now()`.
Every screen and the admin preview share the server's clock, so two screens showing a
countdown agree to the frame. Timers are fine for redrawing. See the template's clock.

**Lifecycle.**

- `prepare()` is awaited before the element is shown. Preload images or fonts there, so a
  scene never appears half-drawn.
- `enter(at)` and `exit(at)` tell you when the element becomes visible and starts leaving.
- `dispose()` comes before removal. Clear timers there or in `disconnectedCallback`.

**Hidden elements.** The compositor often keeps an element mounted while nobody can see it:
the next scene is prepared before it enters, the theme background (which can be a scene) fades
out behind a scene with its own background, an interrupt can hide the scene and overlays below
it, a blackout covers everything, and a widget fades out while its slot is reserved or it is
stale. `visible` is `false` while that lasts. It turns `true` before a fade-in starts and
`false` only once the fade-out has finished, so the element is never seen frozen. An element
that animates every frame, such as a WebGL scene, should stop drawing while it is hidden:

```ts
protected override updated(changed: PropertyValues) {
  if (changed.has("visible")) {
    if (this.visible !== false) this.#start();
    else this.#stop();
  }
}
```

Older Storbild hosts never set `visible`, so treat anything but `false` as visible, and
don't wait for it to become `true` before you draw.

**Theme.** The active theme reaches you only as CSS variables. Always give a fallback:

| Variable | |
|---|---|
| `--sb-font-heading`, `--sb-font-body`, `--sb-font-mono` | font stacks |
| `--sb-color-text`, `--sb-color-muted`, `--sb-color-accent`, `--sb-color-surface` | colours |
| `--sb-safe-area` | the inset from the screen edge that projectors don't cut off |
| `--sb-gap` | the spacing between overlay widgets |

**Assets.** A `fields.asset()` value is an ID. Get its URL with `this.ctx.assetUrl(id)`. Screens
cache the assets the show uses, so they keep working through a network outage.

**Overlays** size themselves inside their slot. A widget whose data can go out of date (for
example "now playing" from an upstream feed) overrides `staleAt()` to return the server time
at which it goes stale. It then fades out until it is fresh again.

The compositor draws each widget's **frame**: the padding, border, rounded corners, background
and shadow, styled by the theme. Render only the content, on a transparent host, and don't
give it a background or padding of your own. Text colour is inherited from the frame. A widget
that needs its own shape sets `frame: false` on its type.

## Custom admin editors

Most types are fine with the generated form. For a live preview or a friendlier control, name
an `editor` element on the type and define it in your `storbild.admin` module. The admin sets
`value`, `schema`, `settings` and `issues` on it (`EditorProperties` in
`@storbild/plugin-sdk/admin`), and expects a `change` event with `detail: { value }`. The
editor can render the generated form for the schema with `<sb-form>` next to its own UI, as the
Wi-Fi editor in [`plugins/info/src/admin.ts`](../plugins/info/src/admin.ts) does. `<sb-form>`
and `<sb-field>` use the admin's design tokens, so the editor matches the rest of the admin.

## Server parts

A plugin that needs to talk to the outside world (poll an API, receive a webhook) adds a
`server` function. It runs in the host process:

```ts
server(ctx) {
  const timer = setInterval(async () => {
    const res = await fetch("https://example.org/now-playing.json", { signal: ctx.signal });
    ctx.setPluginState(await res.json());
  }, 10_000);
  ctx.signal.addEventListener("abort", () => clearInterval(timer));
},
```

`ctx` gives you:

- `settings()` and `onSettingsChange()`.
- `instances(type?)` and `onInstancesChange()`.
- `setPluginState(json)`, shared by all instances, and `setInstanceState(id, json)`. Screens
  receive them as `pluginState` and `state`.
- `route(handler)`: handles `/api/plugins/<id>/*` on the admin app, behind the admin login.
- `log` and `signal`.

Stop everything when `signal` aborts. That happens when the plugin is reloaded, its settings
become invalid, or the server shuts down.

If the server part throws, the host marks the plugin `error` in the admin and restarts it
with backoff: 1 s, doubling up to 60 s. A settings change retries at once. The show keeps
running either way. Keep state small, because every change is sent to every screen.

## The dev loop

Run Storbild from a checkout with your plugin on the plugin path, and with watching on:

```sh
# in the storbild checkout, with .env set up as in the README
STORBILD_PLUGIN_PATHS=/path/to/my-plugin STORBILD_PLUGIN_WATCH=1 bun run dev
```

Every save reloads the plugin. Its new modules get new URLs, and open screens and admin pages
reload to pick them up. A broken edit shows as `error` on the admin's Plugins page, and fixing
it brings the plugin back. `STORBILD_PLUGIN_PATHS` takes several paths, separated by `:`.
Leave watching off at the party.

Test the definition with `bun test`, as the template does: parse example configs, check
`duration` and `migrate`. Test viewer elements in the dev loop, on a real screen size.

## Installing a plugin in a deployment

A plugin is installed as a directory on the server. See [deployment.md](deployment.md) for
the details of each setup.

- **systemd.** Put the plugin anywhere the `storbild` user can read, for example
  `/opt/storbild-plugins/hello`, and run `bun install --production` in it if it has
  dependencies of its own. Then add the path to `STORBILD_PLUGIN_PATHS` in
  `/etc/storbild/storbild.env`, and restart the service.
- **Containers.** Mount each plugin directory under `/plugins`, for example
  `/plugins/hello`, and set `STORBILD_PLUGIN_PATHS=/plugins/hello`.

Plugins are loaded at startup. A plugin that fails to load is reported in the admin and left
out, and the rest of the show runs. A plugin that is removed leaves its instances in the
show, marked as missing, until it is installed again.

## Shipping built ESM

TypeScript sources are fine for the host. To publish a plugin to npm as built JavaScript,
`@storbild/plugin-sdk/build` has `buildPlugin()`, which keeps `lit`, `zod` and the SDK
external. Point `exports["."]` and `storbild.viewer` at the built files. Ship `.d.ts` files
too if other code imports your plugin.

## Compatibility

The SDK's major version is the plugin API version. Within a major version, plugins keep
working on newer hosts. A breaking change bumps both, and older plugins are reported as
`incompatible` instead of breaking the show.

A minor release may still ask you to adapt for your plugin to look or behave right, for example
when the host takes over something plugins used to do. The
[changelog](../packages/plugin-sdk/CHANGELOG.md) lists every change that affects plugins,
including changes in the host, and starts a release with **Action needed** when you should
change your plugin. The same notes are on the `sdk-v*` releases on GitHub, so Dependabot and
Renovate show them in their update pull requests.
