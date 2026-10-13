# Deploying Storbild

This guide sets up Storbild for a party: the server on a VPS (or any Linux machine) behind
Caddy, and one or more screens running Chromium in kiosk mode. It assumes you can use a Linux
shell and own a domain.

- [How it fits together](#how-it-fits-together)
- [DNS](#dns)
- [Server with systemd](#server-with-systemd)
- [Server with containers](#server-with-containers) (compose, or Podman Quadlet)
- [Screens](#screens)
- [Before the party](#before-the-party)
- [Upgrading and backups](#upgrading-and-backups)
- [Troubleshooting](#troubleshooting)

## How it fits together

```
 projector ── kiosk (Chromium) ──https──► screen.party.example.org ─┐
                                           (Caddy, basic auth)       ├─► Storbild :3000 viewer
 any browser (mirrors) ──────────https──► screen.party.example.org ─┘
 crew laptop ────────────────────https──► admin.party.example.org ───► Storbild :3001 admin
                                           (Caddy, Storbild login)
```

Storbild is one process with two apps on two ports. The viewer app (`:3000`) serves the
screen, and the admin app (`:3001`) serves the admin. Each gets its own hostname in Caddy, and
Storbild only listens on loopback, so the screen's hostname can never reach the admin.

- The **screen host** is protected by basic auth in Caddy, so the show isn't public. The kiosk
  and any mirrors use the same user and password.
- The **admin host** is protected by Storbild's own login: one user, whose password hash you
  generate below.

All state lives in the data directory: an SQLite database and the uploaded files. The
screens keep playing through network outages and server restarts, and catch up afterwards.

## DNS

Create two records for the server's address, for example:

| Name | Type | Value |
|---|---|---|
| `screen.party.example.org` | A (and AAAA for IPv6) | the server's address |
| `admin.party.example.org` | A (and AAAA for IPv6) | the server's address |

Set them up before starting Caddy. It requests TLS certificates for both names on its first
start, and that only works once the names resolve to the server.

## Server with systemd

Tested on Debian 13. Run everything as root (or with `sudo`).

### Install Bun and Storbild

Install a release of Storbild, and the Bun version pinned in that release's `.bun-version`:

```sh
apt-get install -y git unzip curl
git clone https://github.com/Kwarf/storbild.git /opt/storbild
cd /opt/storbild
git checkout v1.0.0                      # the release to run
curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v$(cat .bun-version)"
bun install --frozen-lockfile --production
```

Create the user the service runs as:

```sh
useradd --system --home-dir /var/lib/storbild --shell /usr/sbin/nologin storbild
```

### Configure

Generate the admin password's hash. The hash is printed on the first line:

```sh
cd /opt/storbild && bun run hash-password
```

Then write `/etc/storbild/storbild.env`. systemd takes the values literally, so paste the
hash as it is, without quotes or escapes:

```sh
install -d -m 0755 /etc/storbild
install -m 0640 -g storbild /dev/null /etc/storbild/storbild.env
editor /etc/storbild/storbild.env
```

```sh
STORBILD_ADMIN_PASSWORD_HASH=$argon2id$v=19$m=65536,t=2,p=1$...
STORBILD_VIEWER_URL=https://screen.party.example.org
STORBILD_ADMIN_URL=https://admin.party.example.org
```

[`.env.example`](../.env.example) lists every setting with its default, including the upload
size limits and `STORBILD_PLUGIN_PATHS` for [external plugins](plugin-authoring.md#installing-a-plugin-in-a-deployment).
Leave `STORBILD_HOST` at `127.0.0.1`. The unit sets `STORBILD_DATA_DIR=/var/lib/storbild`.

### Start the service

```sh
cp /opt/storbild/deploy/storbild.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now storbild
systemctl status storbild
```

`journalctl -u storbild -f` shows the log. The unit restarts Storbild if it exits. On a
restart, screens show the offline pill and keep playing until it's back.

### Caddy

Debian's own `caddy` package is too old for the Caddyfile; install Caddy from
[its repository](https://caddyserver.com/docs/install#debian-ubuntu-raspbian):

```sh
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
```

Pick the screen password, and hash it for Caddy:

```sh
caddy hash-password
```

Copy the example Caddyfile and fill it in. Replace `{$DOMAIN}` with your domain (or set
`DOMAIN` in Caddy's environment with `systemctl edit caddy`), and put the hash after `screen`:

```sh
cp /opt/storbild/deploy/Caddyfile.example /etc/caddy/Caddyfile
editor /etc/caddy/Caddyfile
systemctl reload caddy
```

Don't add `encode` to these sites: the screens' event streams must not be compressed.

### Firewall

Only SSH, HTTP and HTTPS need to be reachable. With nftables or ufw, allow 22, 80 and 443
(TCP, and UDP 443 for HTTP/3), and nothing else. Storbild's ports are on loopback anyway.

Now open `https://admin.party.example.org`, log in as `admin` (or your
`STORBILD_ADMIN_USERNAME`), and check that `https://screen.party.example.org` asks for the
screen password and then shows the screen.

## Server with containers

The image is `ghcr.io/kwarf/storbild`, for amd64 and arm64. Its tags are each release's
version (`1.0.0`), its minor version (`1.0`), and `latest`. Pin an exact version for a party,
so nothing changes unless you change it.

Inside the container, the database and the files are in the `/data` volume, the apps listen
on `3000` and `3001`, and the health check asks the viewer for `/time`. Both setups below run
the same image. Use compose for Caddy and Storbild together in containers. Use Quadlet to run
Storbild rootless under systemd, with Caddy on the host.

To generate the admin password's hash with the image:

```sh
podman run --rm -it ghcr.io/kwarf/storbild:1.0.0 bun run hash-password
```

(`docker run` works the same way.)

### Compose

With Docker (with the compose plugin) or Podman (with `podman-compose`) installed:

```sh
mkdir -p /opt/storbild && cd /opt/storbild
base=https://raw.githubusercontent.com/Kwarf/storbild/v1.0.0/deploy
curl -fsSLO "$base/compose.yaml"
curl -fsSL "$base/Caddyfile.example" -o Caddyfile
```

1. Edit `compose.yaml`: set the image tag to the release you want.
2. Put the screen password's hash (`caddy hash-password`, or
   `docker run --rm caddy:2 caddy hash-password`) after `screen` in `Caddyfile`. Keep
   `{$DOMAIN}` and `{$STORBILD_UPSTREAM:…}` as they are; compose fills them in.
3. Write `storbild.env`. Compose expands `$` in values, so put the admin password's hash in
   single quotes:

   ```sh
   STORBILD_ADMIN_PASSWORD_HASH='$argon2id$v=19$m=65536,t=2,p=1$...'
   STORBILD_VIEWER_URL=https://screen.party.example.org
   STORBILD_ADMIN_URL=https://admin.party.example.org
   ```

4. Write `.env` with the domain, then start:

   ```sh
   echo DOMAIN=party.example.org > .env
   docker compose up -d        # or: podman compose up -d
   docker compose ps
   ```

Compose doesn't publish Storbild's ports at all; Caddy reaches it over the compose network.
`docker compose logs -f storbild` shows the log.

### Podman Quadlet

This runs Storbild as a rootless container under a regular user's systemd, with Caddy
[on the host](#caddy) as in the systemd setup. It needs Podman 4.4 or later (Debian 13 has 5).

```sh
apt-get install -y podman
useradd --create-home --shell /bin/bash storbild
loginctl enable-linger storbild          # start the user's services at boot
sudo -iu storbild
```

As the `storbild` user:

```sh
export XDG_RUNTIME_DIR=/run/user/$(id -u)
mkdir -p ~/.config/containers/systemd ~/.config/storbild
base=https://raw.githubusercontent.com/Kwarf/storbild/v1.0.0/deploy
curl -fsSL "$base/storbild.container" -o ~/.config/containers/systemd/storbild.container
editor ~/.config/containers/systemd/storbild.container   # set Image= to the release
editor ~/.config/storbild/storbild.env
```

Podman reads the env file literally, so paste the hash without quotes or escapes, as for
[systemd](#configure). Then start it:

```sh
systemctl --user daemon-reload
systemctl --user start storbild
systemctl --user status storbild
podman healthcheck run storbild && echo healthy
```

Quadlet units are enabled by their `[Install]` section, so there's no `systemctl enable`.
`journalctl --user -u storbild -f` shows the log. The container publishes its ports on
`127.0.0.1`, so the Caddyfile works unchanged.

### External plugins in a container

Mount each plugin directory under `/plugins`, and list each one in `STORBILD_PLUGIN_PATHS`,
for example `STORBILD_PLUGIN_PATHS=/plugins/hello:/plugins/scores`. Both `compose.yaml` and
`storbild.container` have a commented example of the mount.

## Screens

A screen is a small computer next to the projector, running Chromium full screen on the
screen URL. It starts on its own after a power cut, never shows browser UI, and doesn't
update its browser under the show. Two platforms are supported:

- **Debian 12 or 13** on a mini PC (any recent Intel or AMD GPU). Install it without a
  desktop: in the installer's software selection, keep only "standard system utilities" and
  the SSH server.
- **Raspberry Pi OS Lite** (64-bit) on a Raspberry Pi 4 or 5.

Mirrors (a second projector, the crew's laptops) can be any browser on the screen URL.

### Set up

On the screen machine, as root:

```sh
apt-get install -y git
git clone https://github.com/Kwarf/storbild.git /opt/storbild
/opt/storbild/deploy/kiosk/setup.sh
```

The script:

- installs `cage` (a Wayland compositor that shows a single app) and Chromium
- holds Chromium, and keeps it out of unattended upgrades
- installs a Chromium policy that turns off updates, translation and sign-in prompts
- creates a `kiosk` user
- keeps the console from blanking
- enables `storbild-kiosk.service`, which runs cage and Chromium on the first console

Then set the screen URL. It carries the screen user and password, so Chromium can pass
Caddy's basic auth without a prompt:

```sh
editor /etc/storbild-kiosk.env
```

```sh
STORBILD_SCREEN_URL=https://screen:the-screen-password@screen.party.example.org/
```

Percent-encode special characters in the password (`@` is `%40`, `:` is `%3A`). The file is
readable only by root and the `kiosk` user. Start the screen, or reboot to check that it comes
up on its own:

```sh
systemctl start storbild-kiosk
```

`journalctl -u storbild-kiosk` shows Chromium's output. Run `setup.sh` again after pulling a
newer checkout, to update the scripts.

### Chromium updates

Chromium is held, so `apt upgrade` leaves it alone. Update it on purpose, well before the
party, and check the screen afterwards:

```sh
apt-mark unhold 'chromium*'
apt-get update && apt-get install --only-upgrade chromium   # chromium-browser on older Pi OS
apt-mark hold $(dpkg-query -W -f '${db:Status-Abbrev} ${Package}\n' 'chromium*' | sed -n 's/^ii *//p')
systemctl restart storbild-kiosk
```

### Check that it survives outages

With a show running:

1. Unplug the screen's network. After about 10 seconds a small offline pill appears in a
   corner, and the rotation keeps going.
2. Plug it back in. The pill goes away, and changes made in the meantime appear.
3. Restart the server (`systemctl restart storbild`). The screen keeps playing and catches up.
4. Reboot the screen with the network unplugged. It starts from its cache and plays the show
   it last saw.

## Before the party

- Build the show at home and download it from the admin's **Settings** page, under **Show
  file** (**Download show file**). The show file is one zip with all the uploaded files.
  Import it on the party server on the same page.
- Check the server's clock (`timedatectl` should say it's synchronised). Screens follow the
  server's clock, so scheduled cues fire on the server's time.
- Set up the screens on the party network, and run through
  [the outage checks](#check-that-it-survives-outages).
- Leave `STORBILD_PLUGIN_WATCH` off.

## Upgrading and backups

The data directory (`/var/lib/storbild`, or the `storbild-data` volume) is the only state.
Before every upgrade, download a show file from the admin's **Settings** page. That is the backup,
and it imports into any install. To copy the data directory itself, stop the server first.

**systemd:**

```sh
cd /opt/storbild
git fetch --tags && git checkout v1.1.0
# If .bun-version changed, install that Bun version as above.
bun install --frozen-lockfile --production
systemctl restart storbild
```

**Compose:** change the image tag in `compose.yaml`, then
`docker compose pull && docker compose up -d`.

**Quadlet:** change `Image=` in `storbild.container`, then
`systemctl --user daemon-reload && podman pull <image> && systemctl --user restart storbild`.

Screens keep running the viewer they loaded, which works with the new server. Restart them
(`systemctl restart storbild-kiosk`) to load the new version, and reload any mirrors.

## Troubleshooting

| Symptom | Check |
|---|---|
| The screen shows the offline pill while the network is up | The event stream is blocked or buffered. Caddy must not `encode` these sites, and any other proxy in front must not buffer `text/event-stream` |
| `Invalid configuration` on start | The message names the setting. The password hash must start with `$argon2id$`: in compose it needs single quotes, in systemd and Podman env files none |
| Caddy fails to get certificates | The DNS records must point at the server, and ports 80 and 443 must be open |
| The kiosk shows a password prompt | The credentials in `STORBILD_SCREEN_URL` don't match the Caddyfile, or need percent-encoding |
| A plugin shows `error` in the admin | The admin's Plugins page shows why. The show keeps running without it |
| The screen is black | `journalctl -u storbild-kiosk`. On Debian, the GPU may need firmware (`firmware-misc-nonfree` or `firmware-amd-graphics`) |

Logs: `journalctl -u storbild` (systemd), `docker compose logs storbild` (compose),
`journalctl --user -u storbild` (Quadlet), and `journalctl -u storbild-kiosk` on a screen.
