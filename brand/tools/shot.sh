#!/bin/zsh
# Screenshot an HTML file with headless Chrome. usage: shot.sh in.html out.png W H
PROFILE=$(mktemp -d)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --user-data-dir="$PROFILE" --screenshot="$2" --window-size="$3,$4" --virtual-time-budget=2500 "file://$1" 2>/dev/null
rm -rf "$PROFILE"
