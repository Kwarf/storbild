# 29. Changelogs

Date: 2026-10-15

## Status

Accepted. Extends ADR 0026 (publishing the SDK and the image).

## Context

Storbild has two kinds of downstream users, and releases for each: people who run it (the
`v<version>` image) and plugin authors (`@storbild/plugin-sdk`, `sdk-v<version>`). Neither
release says what changed or what to do about it.

Semver doesn't cover it for plugin authors:

- Some changes are in the host, not the SDK. When the compositor started drawing widget frames
  (ADR 0028), every widget that drew its own box got a second one on the next Storbild
  release, whatever SDK version it was built with.
- Some changes are additive in the API but still ask plugins to change: `frame` is a new
  optional field, so SDK 1.1.0 is a minor release, yet existing widgets should drop their
  boxes.

And people who run Storbild need to know before they upgrade when a release changes how the
screens look, needs a configuration change, or changes the deployment files.

The server's `package.json` version was `0.0.0`, so only the tag said which release it was.

## Decision

**Two changelogs, one per audience**, both in the Keep a Changelog format:

- `CHANGELOG.md` at the root, for people who run Storbild: features, behaviour on the screens
  and in the admin, configuration and deployment. A release that needs something done before
  or after upgrading starts with an **Upgrading** section. Changes that affect plugins link to
  the SDK changelog instead of repeating it.
- `packages/plugin-sdk/CHANGELOG.md`, for plugin authors: the SDK's API, and what the host
  does around plugins, with the Storbild release a host change ships in. A release that asks
  plugins to change starts with **Action needed**, with concrete steps and a diff where it
  helps. The SDK build copies it into `dist/`, so it ships in the npm package, and the SDK's
  README and `docs/plugin-authoring.md` link to it.

**Versions and notes.**

- Changes go under `## Unreleased` as they land. The commit that releases bumps the version
  and renames that section to `## <version> — <date>`.
- The server's version is `packages/server/package.json`, bumped for each `v<version>` tag,
  as the SDK's is for each `sdk-v<version>` tag. It starts at 1.0.0, the release already
  tagged.
- `scripts/changelog.ts` prints a version's notes from a changelog.
  `scripts/changelog.test.ts` fails when either package's version has no notes, so a version
  bump can't skip its changelog.
- Each publish job checks that the tag matches its package's version and that the notes exist,
  before it builds anything.
- After it, a separate job creates a GitHub release for the tag with the notes. Dependabot and
  Renovate put GitHub release notes in their update pull requests, and anyone can watch the
  repository's releases. `docs/deployment.md` points to the changelog before upgrading.
- Some changes can't be detected by a test. AGENTS.md asks for an entry under Unreleased in
  each changelog a change affects.

## Consequences

- Creating a release needs `contents: write`. Only the two release jobs have it, and they run
  no dependencies' code: they check out the repository, run the changelog script, which has no
  dependencies, and call `gh`. The publish jobs keep `contents: read`. If creating a release
  fails, that job can be re-run without publishing again; it edits the release if one exists.
- A host change that affects plugins without an SDK release waits in the SDK's Unreleased
  until the next SDK version. If it asks plugins to change, that is reason to cut an SDK
  release.
- The compatibility promise stays: within a major version, plugins keep loading and running.
  A minor release may ask them to adapt to look or behave right.
- Tagging a release is now a commit first (the version and the changelog), then the tag.
