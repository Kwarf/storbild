#!/bin/sh
# Starts Chromium full screen on the Storbild screen URL. Run by cage from
# storbild-kiosk.service (ADR 0027); cage exits when Chromium does, and systemd restarts both.
set -eu

# shellcheck source=/dev/null
. /etc/storbild-kiosk.env
: "${STORBILD_SCREEN_URL:?set STORBILD_SCREEN_URL in /etc/storbild-kiosk.env}"

profile="$HOME/.config/storbild-kiosk"
mkdir -p "$profile/Default"
# After a power cut Chromium thinks it crashed and offers to restore the last session.
prefs="$profile/Default/Preferences"
if [ -f "$prefs" ]; then
  sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' "$prefs"
fi

browser=$(command -v chromium || command -v chromium-browser)

# The flags from DESIGN.md §7. The cursor theme from setup.sh hides cage's cursor, and the page
# hides Chromium's.
exec "$browser" \
  --ozone-platform=wayland \
  --user-data-dir="$profile" \
  --kiosk \
  --noerrdialogs \
  --disable-session-crashed-bubble \
  --no-first-run \
  --autoplay-policy=no-user-gesture-required \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --disable-component-update \
  --check-for-update-interval=31536000 \
  --disable-features=Translate \
  --password-store=basic \
  "$STORBILD_SCREEN_URL"
