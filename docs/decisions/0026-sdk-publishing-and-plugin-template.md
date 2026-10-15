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
  The package's trusted publisher is this repository's `release.yml`, and it may publish
  directly. There is no staging step and no token to leak: only a run of that workflow, from
  a pushed tag, can publish without the maintainer's 2FA.
  The commit that bumps the SDK's version also bumps the template's dev dependency and peer
  range, and the example in `docs/plugin-authoring.md`, to the new version.
- `v<version>` builds the server image for linux/amd64 and linux/arm64 and pushes it to GHCR
  as `<version>`, `<major>.<minor>` and `latest` (ADR 0023).

**The template is in this repository**, at `templates/plugin/`, outside the Bun workspaces.
It depends on the published SDK, and authors copy it. It ships TypeScript
sources, which the host bundles itself (ADR 0004), so it needs no build step; `buildPlugin` is
there for authors who want to publish built ESM.

**Pack test.** CI packs `dist/`, installs the tarball into a copy of the template, type checks
the template and runs its tests, and starts the host with it on `STORBILD_PLUGIN_PATHS`. It
needs the network, so it only runs with `STORBILD_PACK=1`, and the root `bun test` skips
`templates/`. This checks
the published package and the template together on every change.

## Consequences

- Authors install the SDK from npm, with no linking and no TypeScript-only settings.
- The template can't drift from the SDK without failing CI.
- There is no repository to use as a GitHub template; `docs/plugin-authoring.md` says how to
  copy the folder.
- 1.0.0 was published by hand, and 1.0.1, the same code, was the workflow's first release,
  which validated the trusted publisher. 1.0.0 was then unpublished, so 1.0.1 is the first
  version on npm, and the template and docs require it.
- A pushed `sdk-v*` tag is enough to publish, so pushing tags is the release decision.
