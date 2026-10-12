# 22. Move to GitHub

Date: 2026-10-12

## Status

Accepted. Replaces the hosting and portability parts of ADR 0002's CI section.

## Context

ADR 0002 hosted the project on a private Forgejo instance and kept the CI workflow portable so
that a move to GitHub would need no workflow changes. The repository is now moving to a public
GitHub repository, where anyone can fork it and open pull requests.

## Decision

**Hosting.** The repository lives on GitHub, and CI runs on GitHub Actions. The Forgejo
portability rules (the `ubuntu-latest` runner label mapping, `DEFAULT_ACTIONS_URL`) no longer
apply.

**Workflow.** `.github/workflows/ci.yml` keeps its steps (typecheck, `biome ci`, `bun test` and
the e2e tests in Chromium), with two changes for a public repository:

- `push` runs only on `main`. Other branches are checked through their pull request, so a pull
  request from a branch in the repository doesn't run twice.
- `permissions: contents: read`, so the workflow's token can't write to the repository.

There is no concurrency group: a run takes about four minutes.

**Package metadata.** The root package and `@storbild/plugin-sdk` declare `"license": "MIT"`,
matching `LICENSE`.

## Consequences

- Pushes to branches without a pull request get no CI run.
- Workflows may use GitHub-only features.
