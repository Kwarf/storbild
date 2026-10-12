# Storbild

Plugin-based big-screen software for demoparties.

> [!WARNING]
> This project was developed entirely through agentic coding. Its code has not been audited in any way.
> I did this because I wanted to finish it within a week, and I'm not a web/frontend developer.
> Commits with agent-written code are always tagged with `Assisted-by`.

> [!NOTE]
> Storbild is not ready for production use. I have not yet had a test run of it at an actual party.

![The admin's Live page](docs/screenshots/admin-live.png)

See more of the admin interface and big-screen samples in [SCREENSHOTS.md](SCREENSHOTS.md).

## Why Storbild

- **It runs itself.** Most of the party the screen loops through the rotation and the schedule on its own. Nobody needs to watch it.
- **It survives a bad network.** The screen keeps playing from its last known state if the venue uplink drops, and catches up when the connection is back.
- **Every screen shows the same thing.** Mirrors in the bar or the media booth follow the main screen, because everything is timed by the server's clock.
- **Live control when you need it.** Put a scene on air now, announce something over everything else in a few seconds, or black out every screen.
- **Cues at set times.** Schedule the compo countdown for 21:55 or the deadline reminder for 21:30 ahead of time, so nobody has to remember to press a button.

## Features

- **Scenes:** Markdown text, slideshows, countdowns and announcements.
- **Overlays:** a clock, the Wi-Fi network with a QR code to join it, a countdown and short Markdown text, placed in slots around the edge of the screen.
- **Themes:** one look for the whole party, with your own background, fonts and colours.
- **Files:** upload images, videos and fonts once and use them anywhere.
- **Show files:** export the whole show, files included, as one zip. Prepare at home, then import it at the venue.
- **Plugins:** scenes and overlays are plugins, and you can write your own.
- **A clean admin** in light or dark mode, with a live preview of the screen.

## Getting started

Storbild needs [Bun](https://bun.sh).

```sh
bun install
bun run hash-password   # prints the line to put in .env
cp .env.example .env    # then paste the password hash into it
bun run dev
```

Open the admin at <http://localhost:3001> and log in as `admin`. The screen is at <http://localhost:3000>; open it full-screen in a browser on the machine that drives the projector.

The screen and the admin are served on separate ports on purpose, so that the screen's address can never reach the admin. Put each on its own hostname behind a reverse proxy; [deploy/Caddyfile.example](deploy/Caddyfile.example) shows how with Caddy.

To look around with some content, `bun run demo --serve` starts a demo show instead (log in as `admin` / `correct horse`).

## Development

[DESIGN.md](DESIGN.md) describes the architecture and the plan, and [docs/decisions/](docs/decisions/) holds the decisions made along the way. [AGENTS.md](AGENTS.md) lists the commands for tests, type checks and linting.

## License

[MIT](LICENSE)
