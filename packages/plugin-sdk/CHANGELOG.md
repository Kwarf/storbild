# Changelog

Every change that affects plugins: the SDK's API, and what the Storbild host does around
plugins. Host changes say which Storbild release they ship in, since that is when a plugin sees
them, whatever SDK version it was built with. A release that asks plugins to change starts with
**Action needed**.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [semver](https://semver.org/): the major version is the plugin API version
(`apiVersion`).

## Unreleased

## 1.2.0 — 2026-10-16

### Added

- `visible` on scenes and overlays: `false` while the element is mounted but can't be seen
  (prepared before it enters, under a faded-out layer or a blackout, or a widget faded out for
  a reserved slot or stale data), so an element that animates every frame can stop drawing
  ([ADR 0030](https://github.com/Kwarf/storbild/blob/main/docs/decisions/0030-element-visibility.md)).
  It turns `true` before a fade-in and `false` after a fade-out. The host sets it from
  Storbild 1.2.0 on; older hosts leave it `undefined`, so treat anything but `false` as
  visible.

## 1.1.0 — 2026-10-15

### Action needed

The host now draws a frame around every overlay widget, styled by the theme
([ADR 0028](https://github.com/Kwarf/storbild/blob/main/docs/decisions/0028-widget-frames.md)).
A widget that draws its own box gets a second one around it.

- If your widget draws a box (background, padding, border radius), remove them and render only
  the content. Text colour is inherited from the frame:

  ```diff
   :host {
     display: block;
  -  padding: 12px 28px;
  -  border-radius: 8px;
  -  background: var(--sb-color-surface, #15171c);
  -  color: var(--sb-color-text, #fff);
     font-family: var(--sb-font-heading, sans-serif);
   }
  ```

- If your widget needs its own shape, such as a full-width ticker, keep its styles and set
  `frame: false` on its type.
- Raise your peer dependency to `"@storbild/plugin-sdk": "^1.1.0"` if you use `frame`.

### Added

- `frame?: boolean` on overlay types. `false` makes the compositor draw no frame around the
  widget. Default `true`.
- `<sb-field>`: an optional select shows its field's `placeholder` as the empty choice,
  instead of "None".

### Changed

- Host (Storbild 1.1.0): the compositor draws each widget's padding, border, radius,
  background, blur and shadow from the theme's new `widgets` settings. The default is a
  see-through, blurred panel with a soft shadow.
- Host (Storbild 1.1.0): a widget larger than its slot's size cap shrinks to the cap
  and is clipped inside its frame, where it used to be cut off at the slot's edge. Frame
  shadows may reach past the slot.

## 1.0.1 — 2026-10-13

The first release from CI, with the same code as 1.0.0, which was published by hand and has
been unpublished. Depend on `^1.0.1` or later.

### Added

- `definePlugin`, `z`, `fields` and the plugin types (`@storbild/plugin-sdk`).
- `StorbildScene` and `StorbildOverlay`, the Lit base classes for the screen
  (`@storbild/plugin-sdk/viewer`).
- `<sb-form>` and `<sb-field>` for custom admin editors (`@storbild/plugin-sdk/admin`).
- `buildPlugin` and `pluginExternals` for shipping built ESM (`@storbild/plugin-sdk/build`).
