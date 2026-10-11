# 10. Admin forms and content pages

Date: 2026-10-11

## Status

Accepted

## Context

M6a (DESIGN.md §9, ADR 0009) makes the admin able to build a show: generated forms for plugin
config and settings, the Library, Rotation, Plugins and Settings pages, and the default
rotation duration and transition length as settings instead of constants. That raised these
questions:

- Where the show-wide settings live, and how they reach the viewer.
- How the admin gets the JSON Schemas it generates forms from. ADR 0004 deferred "a JSON Schema
  endpoint and generated forms" to this milestone.
- How a schema says that a string is markdown or a colour, or that a number is a duration or a
  point in time. Plain JSON Schema can't express this.
- Which form components the SDK exposes, and where a plugin's custom editor element is
  registered.
- How a `missing` plugin is removed for good, which ADR 0004 left to the Plugins page.

## Decision

**Show settings are state.** `ShowState.settings` is `{ defaultDurationMs, transitionMs }`,
15 000 and 800 by default. The command `settings.update` takes any subset of the two.
`defaultDurationMs` is a positive integer, and `transitionMs` is an integer from 0 to 10 000.
The settings are persisted under the `settings` key in `meta`. A database without the key
loads the defaults, so no migration is needed.

- The scheduler's `resolveDurations` falls back to `settings.defaultDurationMs`. Changing it
  changes resolved durations, which re-anchors the rotation like any other duration edit
  (ADR 0006). `DEFAULT_DURATION_MS` stays only as the fallback for an item the scheduler hasn't
  resolved yet.
- The viewer's crossfade length comes from `settings.transitionMs`. `SceneLayer` reads it on
  every fade unless a fixed `transitionMs` option is given, as the tests do. The compositor's
  CSS fades (background, dim, cover, blackout) use a `--sb-compositor-transition` custom
  property that it sets from the state. `TRANSITION_MS` stays as the fallback.
- The built-in `markdown` plugin no longer declares `duration: () => 15_000`, so text runs for
  the show's default. Its version is now 0.2.0.

**JSON Schemas come from an admin endpoint.** `GET /api/schemas` returns, per usable plugin,
`{ settings?, types: { [type]: schema } }`. Each schema is made once at load with
`z.toJSONSchema(schema, { io: "input" })`, which the host already ran to check
convertibility, so the result is now kept on the plugin module. The endpoint needs a session
and is `no-store`. The schemas are not in `ShowState`, because viewers don't need them and
they change only when plugins are reloaded. The path is not under `/api/plugins/`, because
that prefix belongs to plugin routes (ADR 0004). The admin fetches the schemas on every
(re)connect of its event stream, so a server restart with other plugins is picked up.

**Widget hints come from SDK field helpers.** `@storbild/plugin-sdk` exports `fields`:

- `fields.markdown()`: a string, edited in a multi-line field
- `fields.color()`: a `#rrggbb` string
- `fields.duration()`: a positive integer in milliseconds, entered as seconds or `m:ss`
- `fields.datetime()`: epoch milliseconds in server time, entered in local time

Each is a plain Zod schema tagged with `.meta({ "x-storbild-widget": … })`. Zod carries the
tag into the JSON Schema through `.optional()`, `.default()` and further `.meta()` calls. A
field's label is its `title` (from `.meta()`), else its key in sentence case ("fontScale"
becomes "Font scale"), and `description` (from `.meta()` or `.describe()`) is shown beneath.
Durations and times are numbers in milliseconds, like everything else in state.

**The form model is pure.** `describeForm(jsonSchema)` turns a schema into a field tree with
these kinds:

- the hinted kinds: `markdown`, `color`, `duration`, `datetime`
- `text`, `number` (with `integer`, `minimum`, `maximum`) and `boolean`
- `select`: an `enum`, or a union of `const`s
- `object` and `list`
- `json`: a raw JSON text area for anything else, such as unions, records and tuples

It resolves local `$ref`s, with a depth limit for recursive schemas, and treats `T | null` as
a nullable `T`. `initialValue(field)` gives a new instance its starting config: defaults, plus
empty values for required fields. An unsupported schema never fails; it falls back to `json`.
Validation stays on the server. A refused config or settings value returns `422` with
`issues`, and the form shows each issue at the field its path names.

**The SDK has a third browser subpath, `@storbild/plugin-sdk/admin`.** It exports the form
model and two elements:

- `<sb-field>` renders one field of any kind from a field descriptor, recursing into objects
  and lists.
- `<sb-form>` renders a whole JSON Schema.

Both take `value` and `issues` and fire `change` (a `ValueChangeEvent`, with
`detail.value`) carrying the whole new value. `undefined` means the field is left out. One
element taking a descriptor keeps the public surface smaller than a component per widget,
and a custom editor can still render any single widget with it. The components style
themselves only with the admin's `--sb-*` tokens, which inherit through shadow DOM, with
fallbacks. Like the other subpaths, it is in the vendor build and the import map, so the
admin bundle and plugin modules share one copy.

**Custom editors live in a separate admin module.** A plugin package may name
`"storbild": { "admin": "./src/admin.ts" }`. The host bundles it like the viewer entry, as
`admin.js`, next to `viewer.js` under `/plugins/<id>/<version>/`. Its URL is in
`PluginEntry.adminModule`. Viewers never load it, so screens don't download editor code or
the form components. When a type declares `editor`, the Library imports the admin module and
renders that element with these properties (`EditorProperties`):

- `value`: the config
- `schema`: the config's JSON Schema
- `settings`: the plugin's settings
- `issues`: validation issues from the last save

The editor fires `change` with the whole config. If the module fails to load or doesn't
define the element, the Library shows the generated form with a notice.

**`plugin.remove`** deletes a plugin entry whose status is `missing`, together with that
plugin's instances. Anything that references those instances is removed in the same revision,
exactly as `instance.delete` does. Removing an installed plugin is `422`.

**Singleton types are enforced.** `instance.create` of a `singleton` type that already has an
instance is `422`. The Library marks such a type "(exists)" and doesn't offer it.

**The pages.**

- **Library**: instances grouped by type, with broken ones flagged and a rotation count. The
  panel edits the name and the config (generated form or custom editor) as a draft, with
  Save and Revert, Add to rotation, and Delete. Delete asks for confirmation inline and says
  how many rotation items it removes. Edits made elsewhere replace the draft only while it has
  no unsaved changes.
- **Library preview**: the viewer's compositor, fed a derived state. Only the draft instance
  is on air (`live.main`, holding, with nothing over it), and the show's theme and settings
  apply. Unsaved changes therefore preview at once. Overlays get a preview with M8.
- **Rotation**: dense rows. Each row has these controls:
  - a drag handle, plus up and down buttons for the keyboard
  - the enabled checkbox
  - an inline duration, where blank means automatic and the placeholder shows the resolved
    duration
  - a time window editor with `datetime-local` fields
  - remove

  The row also marks the item that is on air and the next one.
- **Plugins**: per plugin, the version, status, error and types, and a settings form with
  Save and Revert. A `missing` plugin offers removal, with an inline confirmation.
- **Settings**: the default duration (a duration field) and the transition length (in ms).

`parseDuration` and `formatDuration` move from the admin into `packages/core`, so the SDK's
duration field and the admin share them.

## Consequences

- The plugin API is extended without breaking changes: the `fields` helpers, the `/admin`
  subpath and the optional `storbild.admin` entry are all new. `apiVersion` stays at 1.
- The `PluginEntry` schema gains an optional `adminModule`.
- A custom editor runs in the admin page with the operator's session, like every other piece
  of plugin code (plugins are trusted, DESIGN.md §1).
- A value typed into a generated form is only validated when it is saved. The form can't run
  plugin refinements in the browser.
- The e2e probe plugin has a type with a custom editor. A new e2e test builds a text show from
  an empty database in the admin and watches a viewer run it.
- Of the M5 leftovers (ADR 0009), only part of a layout for narrow screens is done: the
  Library stacks its list above the panel. The connected-screens count and plugin webhook
  routes without a session are still open.
