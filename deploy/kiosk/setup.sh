#!/bin/sh
# Sets up a Storbild screen on Debian 12/13 or Raspberry Pi OS Lite (ADR 0027): a `kiosk`
# user, cage and Chromium, Chromium updates held, and storbild-kiosk.service started at boot.
# Run as root from a checkout or a copy of deploy/kiosk/:
#
#   sudo ./setup.sh
#
# Running it again is safe, and updates the scripts and the unit.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo $0" >&2
  exit 1
fi
here=$(cd "$(dirname "$0")" && pwd)

if [ -f /etc/rpi-issue ] || grep -qi raspberry /proc/device-tree/model 2>/dev/null; then
  platform=raspios
else
  platform=debian
fi
echo "Setting up a Storbild kiosk on $platform"

# Chromium is `chromium` on Debian and current Raspberry Pi OS, `chromium-browser` on older
# Raspberry Pi OS.
export DEBIAN_FRONTEND=noninteractive
apt-get update
browser=chromium
if ! apt-cache show chromium >/dev/null 2>&1; then browser=chromium-browser; fi
apt-get install -y --no-install-recommends cage "$browser" fonts-dejavu-core

# Hold Chromium, so a browser update never lands under a running show. Update it on purpose:
# apt-mark unhold, apt-get install --only-upgrade, apt-mark hold.
held=$(dpkg-query -W -f '${db:Status-Abbrev} ${Package}\n' 'chromium*' 2>/dev/null | sed -n 's/^ii *//p')
# shellcheck disable=SC2086
apt-mark hold $held
cat > /etc/apt/apt.conf.d/51storbild-kiosk <<'APT'
// Storbild kiosk: never upgrade Chromium unattended (ADR 0027).
Unattended-Upgrade::Package-Blacklist { "chromium"; };
APT
install -D -m 0644 "$here/policies/storbild-kiosk.json" /etc/chromium/policies/managed/storbild-kiosk.json

# The kiosk user, with access to the GPU and input devices.
if ! id kiosk >/dev/null 2>&1; then
  useradd --create-home --shell /usr/sbin/nologin kiosk
fi
usermod -aG video,render,input kiosk 2>/dev/null || usermod -aG video,input kiosk

install -D -m 0755 "$here/kiosk.sh" /usr/local/lib/storbild-kiosk/kiosk.sh
install -m 0644 "$here/storbild-kiosk.service" /etc/systemd/system/storbild-kiosk.service

if [ ! -f /etc/storbild-kiosk.env ]; then
  install -m 0640 -g kiosk "$here/kiosk.env.example" /etc/storbild-kiosk.env
  configured=no
else
  chgrp kiosk /etc/storbild-kiosk.env
  chmod 0640 /etc/storbild-kiosk.env
  configured=yes
fi

# Keep the console from blanking before cage starts; cage itself never blanks the screen.
case $platform in
  raspios)
    cmdline=/boot/firmware/cmdline.txt
    [ -f "$cmdline" ] || cmdline=/boot/cmdline.txt
    grep -q consoleblank=0 "$cmdline" || sed -i '1 s/$/ consoleblank=0/' "$cmdline"
    ;;
  debian)
    if [ -f /etc/default/grub ] && ! grep -q consoleblank=0 /etc/default/grub; then
      sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT="/&consoleblank=0 /' /etc/default/grub
      update-grub
    fi
    ;;
esac

systemctl daemon-reload
systemctl set-default graphical.target
systemctl enable storbild-kiosk.service

if [ "$configured" = no ]; then
  echo
  echo "Now set the screen URL in /etc/storbild-kiosk.env, then run:"
  echo "  sudo systemctl start storbild-kiosk"
else
  systemctl restart storbild-kiosk.service
  echo "storbild-kiosk restarted"
fi
