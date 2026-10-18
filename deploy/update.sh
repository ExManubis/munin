#!/bin/sh
# Brings munin up to date: the latest of main, then its install script again, which updates the
# database and restarts munin. `munin update` runs this, and so does the update button in
# Settings (through munin-update on Linux, munin.update on a Mac).
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
echo "munin update, $(date)"
git -C "$DIR" pull --ff-only origin main
case "$(uname -s)" in
  Darwin) MUNIN_UPDATING=1 exec "$DIR/deploy/install-mac.sh" ;;
  *) MUNIN_UPDATING=1 exec "$DIR/deploy/install.sh" ;;
esac
