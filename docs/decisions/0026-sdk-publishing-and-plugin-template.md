# 26. Publishing the SDK and the plugin template

Date: 2026-10-13

## Status

Accepted. Specifies the SDK build step anticipated by ADR 0002 and ADR 0004, and refines
M10b's template repository (ADR 0016).

## Context

`@storbild/plugin-sdk` exports TypeScript sources and depends on the private workspace
package `@storbild/core`. Third-party plugins can only use it by linking the sources, with
`allowImportingTsExtensions` (ADR 0004). ADR 0023 publishes it to npmjs, which needs built
files that don't refer to `@storbild/core`.

The SDK uses a small part of core: `API_VERSION`, the `JsonValue`, `OverlaySlot`, `AssetMeta`
and `Issue` types, and `formatDuration` and `parseDuration`.

M10b also plans a template repository. A second repository has to be kept in step with the
SDK by hand, and nothing would check it.

## Decision

**Build.** `bun run build` in `packages/plugin-sdk` writes `dist/`:

- JavaScript for each subpath (`.`, `./viewer`, `./admin`, `./build`), built with Bun. Core is
  bundled in. `lit` and `zod` stay external.
- Declarations emitted by `tsc` for the SDK and the core modules it uses, with each
  `@storbild/core` import rewritten to the bundled `core/` folder.
- A `package.json` with the built exports, `lit` and `zod` as peer dependencies and no
  `@storbild/core`, plus the README and the licence.

The workspace package keeps exporting its sources, so nothing in the repository changes. The
host keeps resolving the SDK to its own sources when it bundles plugins (ADR 0004), so the
published build is only for authors' type checking and builds. `./build` needs Bun's types.

**Versions.** The SDK starts at 1.0.0, so its major version matches `apiVersion` "1". It is
versioned separately from the server.

**Releases.** Releases are pushed tags:

- `sdk-v<version>` builds the SDK, runs the pack test, and publishes `dist/` to npmjs with
  npm's trusted publishing (OIDC) and provenance. The tag must match the built version.
- `v<version>` builds the server image for linux/amd64 and linux/arm64 and pushes it to GHCR
  as `<version>`, `<major>.<minor>` and `latest` (ADR 0023).

**The template is in this repository**, at `templates/plugin/`, outside the Bun workspaces.
It depends on the published SDK, and authors copy it.

**Pack test.** CI packs `dist/`, installs the tarball into a copy of the template, type checks
and builds the template, and starts the host with it on `STORBILD_PLUGIN_PATHS`. This checks
the published package and the template together on every change.

## Consequences

- Authors install the SDK from npm, with no linking and no TypeScript-only settings.
- The template can't drift from the SDK without failing CI.
- There is no repository to use as a GitHub template; `docs/plugin-authoring.md` says how to
  copy the folder.
- The first publish may need a token, if npm can't add a trusted publisher to a package that
  doesn't exist yet.
