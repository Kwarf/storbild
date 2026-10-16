# 31. Shader plugin

Date: 2026-10-16

## Status

Accepted. Adds a built-in plugin to DESIGN.md §6.4. Builds on ADR 0014 (scene backgrounds)
and ADR 0030 (element visibility).

## Context

Operators want WebGL shaders, like the ones on Shadertoy, as theme backgrounds. The theme
already takes a scene as its background (`{ type: "scene", instanceId }`, ADR 0014), so a
shader can be a scene plugin rather than a new background type. As a scene it can also go on
air on its own or be switched to by a cue, and it gets a generated form, validation and error
isolation like any other plugin.

These questions were open:

- Built in or external.
- Which shaders it accepts, and what it provides to them.
- How shader time stays in step across screens without losing float precision.
- How the source gets into the admin, and how compile errors are reported.
- What a screen does with a shader that doesn't compile.

## Decision

**A built-in plugin, `shader`, with one scene type, `shader`.** It is the main use of scene
backgrounds, so it ships with Storbild. The type has `background: "own"`: on air on its own,
it draws the whole screen and the theme background fades out. It has no duration of its own,
so the show's default applies.

**Config.**

- `source`: the GLSL, a string of at most 64 KB. A new instance starts with a short shader of
  our own that uses the theme colours, so it works at once and shows the uniforms in use.
- `loop`: `fields.duration()`, default one hour. Shader time wraps after it (see below).
- `speed`: a number, default 1.
- `scale`: the render scale, 1, 0.75, 0.5 or 0.25, default 1. The canvas renders at
  1920×1080 times the scale and is stretched to fill the stage.
- `fps`: an optional cap, 60, 30 or 24. Without it the shader runs at the display's rate.
- `channels`: up to four images, `fields.asset({ accept: ["image/*"] })`, as `iChannel0`–`3`.
  They are linear-filtered with mipmaps and repeat. Asset IDs in the config are already found
  by `assetUsers` and `referencedAssetIds`, so the images can't be deleted while in use and
  are cached for offline screens.

**What the shader is.** The source defines Shadertoy's
`void mainImage(out vec4 fragColor, in vec2 fragCoord)`, as on its **Image** tab. The plugin
wraps it in WebGL2 (GLSL ES 3.00), as Shadertoy does: a preamble with `#version 300 es`,
`precision highp float`, the uniforms and an output, then `#line 1`, so compile errors carry
the user's own line numbers, then the source, then a `main()` that calls `mainImage` with
`gl_FragCoord.xy`. A full-screen triangle draws it. One module, `src/glsl.ts`, builds the
program text, parses the compile log and lists unsupported inputs, and both the viewer and
the admin editor import it, so the editor checks what the screens run.

**Uniforms.**

- `iResolution` (`vec3`): the canvas size in pixels, after `scale`.
- `iTime` and `iTimeDelta` (`float`): shader time and the time since the last frame, in
  seconds.
- `iFrame` (`int`): frames since the element was mounted. It is not in step across screens.
- `iDate` (`vec4`): year, month (from 0), day and seconds since midnight, from `serverNow()`
  in the screen's time zone.
- `iMouse` (`vec4`): always zero, so shaders that read it still compile.
- `iChannel0`–`3` (`sampler2D`), with `iChannelResolution` (`vec3[4]`).
- `sbText`, `sbMuted`, `sbAccent` and `sbSurface` (`vec3`): the theme colours. The viewer
  reads the `--sb-color-*` variables with `getComputedStyle` (ADR 0014), lets the browser
  resolve them to RGB, and reads them again every second, so a theme change reaches a running
  shader.

Shadertoy's multipass buffers, cubemaps, sound and keyboard inputs, `iSampleRate` and
`iChannelTime` are out of scope.

**Time.** `iTime` is `(serverNow() / 1000 × speed) mod loop`, counted from the Unix epoch
rather than from when the element was mounted. Every screen and the admin preview therefore
show the same frame, and all of them wrap at the same moment. `iTime` is a 32-bit float: at
an hour its steps are about 0.25 ms, while at a day they are about 8 ms, which shows as
stutter. An operator can set `loop` to the shader's own period, so the wrap is seamless.
The epoch milliseconds are reduced in double precision in script before reaching the GPU.

**Rendering.**

- `prepare()` creates the WebGL2 context, compiles and links, loads the channel images, and
  draws one frame, so the scene fades in already drawn.
- The render loop is `requestAnimationFrame`, skipping frames for the `fps` cap. It runs only
  while `visible !== false` (ADR 0030), and draws a fresh frame as soon as the element becomes
  visible.
- **The last shader that compiled stays.** When `source` changes and the new program fails to
  compile or link, the screen keeps running the old one and logs the error. A shader that has
  never compiled, and a screen without WebGL2, leave the scene black, and `prepare()` rejects
  so the failure is logged; the show goes on (DESIGN.md §7).
- A lost context (`webglcontextlost`) is prevented from closing for good, and on
  `webglcontextrestored` the program and textures are built again.
- `dispose()` stops the loop and frees the program, buffers and textures, and calls
  `WEBGL_lose_context` so the context doesn't wait for garbage collection.

**The admin editor.** Shaders are written elsewhere (on Shadertoy, or in an editor with live
reload) and pasted in when they are done, so the custom editor, `sb-shader-editor`, is small
and adds no dependencies:

- a monospace `<textarea>` for `source`, and an "Open file…" button that reads a `.glsl`,
  `.frag` or `.txt` file in the browser and puts its text in the field (it is not stored as
  an asset)
- a compile check when the source changes, debounced while typing, in an offscreen WebGL2
  context with the program text from `glsl.ts`
- the errors as rows below the field ("line 12: …"); a row moves the cursor to its line
- warnings for what isn't provided: `iMouse` (always zero), `iChannelTime`, `iSampleRate`, and
  a source without `mainImage`
- the other fields as `<sb-field>`s, like the Wi-Fi editor (ADR 0015)

Compile errors are not schema issues, so saving isn't blocked: the admin's GPU may reject a
shader that the screens accept, or the other way round. The Library preview (ADR 0010) shows
the draft running, through the same last-compiled rule.

We measured CodeMirror 6 as the field: the smallest useful setup with a GLSL mode is about
355 KB minified, twice the admin's own bundle, and responses aren't compressed (the
deployment docs forbid `encode` on these sites). For pasting finished code, a
`<textarea>` with error rows is enough.

**No import from Shadertoy.** Its API needs an app key that a new account can't get, it only
returns shaders whose authors chose "Public + API", and the site answers server-side requests
with a Cloudflare challenge and doesn't allow cross-origin reads. Pasting the Image tab's code
is the way in.

## Consequences

- A shader is just a scene: it can be the theme background, go on air, sit in the rotation or
  be switched to by a cue, and the interrupt cover never runs a second WebGL context
  (ADR 0014).
- Thanks to ADR 0030, a shader behind a scene with its own background, under an interrupt's
  `hide`, under a blackout or being prefetched costs no GPU time.
- Heavy shaders can still be too much for a kiosk. `scale` and `fps` are the levers, and the
  plugin authoring and theme docs say so. The editor can't measure the screens' GPU.
- Many Shadertoy shaders are licensed CC BY-NC-SA. The starter shader, the demo show and the
  screenshots use shaders written for Storbild.
- Multipass shaders don't work until buffers are added. That would be a later, additive config
  change (`buffers`), with its own ADR.
- `glsl.ts` is pure, so the wrapping, the log parsing and the unsupported-input warnings are
  unit tested. An e2e test in Chromium checks that a shader draws, that a broken edit keeps
  the last one, and that a hidden shader stops drawing.
