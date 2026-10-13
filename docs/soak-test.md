# Soak test

The last check before Storbild is called done (DESIGN.md §9, M10b): **24 hours unattended**
on target-like hardware, set up from [deployment.md](deployment.md) alone, with a forced
network outage and a server restart during the run. Run it once. Record the result at the end
of this file, along with any gaps found in the docs.

## Setup

- **Server:** a fresh VPS (or a machine like the party's), set up from the deployment guide.
  Note which way it runs (systemd, compose or Quadlet). Run the soak on one of them. The other
  only needs to be set up from the docs once.
- **Screen:** a kiosk set up with `deploy/kiosk/setup.sh`, on a projector or monitor at 1080p.
  Use the kind of machine the party will use.
- **Watcher:** a third machine (a laptop is fine) running
  `bun deploy/soak/watch.ts https://screen:<password>@screen.<domain>/ > soak.jsonl`. It logs
  stream drops, revision gaps, silences and `/time` round trips.
- **Show:** start `bun run demo --serve` on a development machine and download its show file
  from the admin's **Settings** page. Import it on the soak server. Then add the items below,
  so the run touches every moving part:
  - a cue that fires during the run
  - a countdown to a time during the run
  - a slideshow, and a video background if the party will use one

## Schedule

| When | What |
|---|---|
| 0 h | Start the watcher. Note the time, the server's and the kiosk's memory use (`ps -o rss,cmd -C bun`, `ps -o rss,cmd -C chromium`), and take a photo of the screen |
| ~1 h | Quick announce from the admin, then resume |
| ~6 h | **Network outage:** unplug the kiosk's network for 10 minutes. Check that the offline pill appears and the rotation continues. Plug it back in |
| ~12 h | **Server restart:** `systemctl restart storbild` (or restart the container). Check that the screen keeps playing and catches up |
| ~18 h | Edit an instance in the admin, and check that the screen picks the edit up |
| 24 h | Stop the watcher with Ctrl-C, and keep its summary. Note memory use again |

## Pass criteria

- The screen never went black, never showed a browser error or dialog, and never got stuck on
  one scene.
- During the outage, the offline pill appeared within about 10 seconds, the rotation kept
  going, and the pill cleared after reconnecting, with changes made during the outage shown.
- After the server restart, the screen caught up without a manual reload.
- The cue fired at its time, and the countdown reached zero on time.
- The watcher logged no `gap`. Every `silent` and stream failure lines up with the outage or
  the restart.
- The memory use of the server and of Chromium at 24 h is in line with 1 h. It may be a little
  higher, but it must not grow without bound.
- `journalctl -u storbild` and `journalctl -u storbild-kiosk` show no repeated errors.

## Results

Fill this in after the run.

| | |
|---|---|
| Date | |
| Storbild version | |
| Server (provider, size, OS, way of running it) | |
| Kiosk (hardware, OS, Chromium version) | |
| Watcher summary | |
| Memory at 1 h / 24 h (server, Chromium) | |
| Outage behaviour | |
| Restart behaviour | |
| Result | |

Doc gaps found while setting up:

-
