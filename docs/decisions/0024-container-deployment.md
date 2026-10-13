# 24. Container deployment

Date: 2026-10-13

## Status

Accepted. Refines M10b's deployment item (ADR 0016).

## Context

M10b plans an optional Docker image, published to GHCR (ADR 0023), but nothing says how to run
it. The `deploy/` layout and `docs/deployment.md` only cover systemd, and the done-when
criterion can be met without the image, so it could ship untested. Podman, which runs the same
images rootless and without a daemon, isn't mentioned.

## Decision

**Image.** `deploy/Containerfile` builds the image, and works with both `docker build` and
`podman build`. It is based on the official Bun image, at the version in `.bun-version`, and
runs as a non-root user. Inside the container:

- `STORBILD_HOST=0.0.0.0`, so the published ports reach the apps. The host publishes them on
  loopback, so only Caddy can reach them.
- `STORBILD_DATA_DIR=/data`, a volume holding the database and the assets.
- `STORBILD_PLUGIN_PATHS=/plugins`, an optional mount for external plugins.
- The health check requests `/time` on the viewer port.

**Compose.** `deploy/compose.yaml` runs Storbild with a named volume for `/data` and Caddy next
to it, using `Caddyfile.example`. It works with both `docker compose` and `podman compose`.

**Quadlet.** `deploy/storbild.container` is a Podman Quadlet file, so Podman can run the
container rootless under systemd without compose. It mirrors `storbild.service`.

**Docs.** `docs/deployment.md` gets a containers section: the volume, the environment
(including the password hash, whose `$` characters need escaping), the ports, and upgrading by
pulling a new tag. The data volume is the only state, and a show export (ADR 0019) is the
backup before an upgrade.

**Done when.** A fresh VPS is also set up once from the container docs. The soak test stays on
one deployment path.

## Consequences

- There are three ways to run the server (systemd, compose and Quadlet), and the docs must keep
  them in step.
- The release workflow builds and pushes the image from `deploy/Containerfile`.
- The deployment layout in DESIGN.md §3 gains the three files.
