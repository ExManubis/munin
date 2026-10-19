#!/bin/zsh
# Render munin wallpapers with headless Chrome.
# usage: ./render.sh [W H] [variant…]     e.g. ./render.sh 5120 2880 eclipse
# QUERY adds URL params and TAG names the files, e.g. QUERY='cell=28' TAG=studio-display ./render.sh 5120 2880 nordlys
# Variants: eclipse2 drift2 orbit nordlys yggdrasil ginnungagap bifrost ravens vortex shear
#           horizon eclipse wing drift rain (all of them by default). PNGs land in renders/.
cd "${0:A:h}"
W=${1:-2880}; H=${2:-1800}; shift $(( $# < 2 ? $# : 2 ))
VARIANTS=(${@:-eclipse2 drift2 orbit nordlys yggdrasil ginnungagap bifrost ravens vortex shear horizon eclipse wing drift rain})
PORT=8765

python3 -m http.server $PORT --bind 127.0.0.1 --directory .. >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
until curl -s -o /dev/null "http://127.0.0.1:$PORT/"; do sleep 0.1; done

mkdir -p renders
for v in $VARIANTS; do
  PROFILE=$(mktemp -d)
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --user-data-dir="$PROFILE" --screenshot="renders/munin-wallpaper-$v-${TAG:-${W}x$H}.png" \
    --window-size="$W,$H" --virtual-time-budget=30000 \
    "http://127.0.0.1:$PORT/wallpaper/wallpaper.html?v=$v&w=$W&h=$H${QUERY:+&$QUERY}" 2>/dev/null
  rm -rf "$PROFILE"
  echo "renders/munin-wallpaper-$v-${TAG:-${W}x$H}.png"
done
