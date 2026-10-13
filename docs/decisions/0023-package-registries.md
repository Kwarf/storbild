# 23. Package registries

Date: 2026-10-13

## Status

Accepted. Settles the npm scope and GitHub organization question in DESIGN.md §11.

## Context

M10b publishes two things: `@storbild/plugin-sdk`, which third-party plugin authors install, and
an optional Docker image of the server. The repository is on GitHub (ADR 0022), so GitHub
Packages and the GitHub Container Registry (GHCR) are alternatives to npmjs and Docker Hub.

GitHub's npm registry needs a token to install even public packages, and its scope must match
the repository owner. GHCR allows anonymous pulls of public images and isn't subject to Docker
Hub's per-IP pull limits, which several machines behind one venue NAT could reach.

## Decision

**SDK.** `@storbild/plugin-sdk` is published to npmjs, under the `storbild` npm organization,
which has been claimed.

**Docker image.** The image is published to GHCR as `ghcr.io/kwarf/storbild`, pushed from
GitHub Actions with the workflow's `GITHUB_TOKEN`.

**Repository.** The repository stays under the `Kwarf` account. A `storbild` GitHub
organization isn't worth the effort for a project without other maintainers.

## Consequences

- Plugin authors install the SDK with no registry configuration or token.
- The publishing workflow needs `packages: write` for the image, beyond ADR 0022's
  `contents: read`.
- The image name follows the repository owner, so moving the repository later would rename it.
