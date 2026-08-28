#!/usr/bin/env bash
# scripts/demo/record.sh — record the Compare demo, start to finish.
#
# Runs the whole take on a virtual X display, so nothing appears on your
# screen, nothing can wander in front of the camera, and the frame size is
# exact rather than whatever your window manager felt like. That also means
# this is safe to run while you are working.
#
# The pieces, in order: Xvfb (the stage) -> diffstalkerd (its own port, its
# own throwaway state, never your real daemon) -> Chrome in app mode at a
# deep link straight into Compare -> choreograph.ts (the direction) with
# ffmpeg grabbing the display while it runs.
#
# Output: scripts/demo/out/raw.mkv  (lossless; feed it to encode.sh)
#
# Usage: scripts/demo/record.sh
# Tunables: DEMO_THEME=light  WIDTH=1440  HEIGHT=900  FPS=30
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

WIDTH="${WIDTH:-1440}"
HEIGHT="${HEIGHT:-900}"
FPS="${FPS:-30}"
DISPLAY_NUM="${DISPLAY_NUM:-:99}"
DEMO_PORT="${DEMO_PORT:-7391}"
CDP_PORT="${CDP_PORT:-9333}"
export DEMO_THEME="${DEMO_THEME:-dark}"

OUT="$repo_root/scripts/demo/out"
WORK="$(mktemp -d /tmp/diffstalker-demo-run.XXXXXX)"
mkdir -p "$OUT"

pids=()
cleanup() {
  # Reverse order: Chrome before the daemon, the display last.
  #
  # No bare `wait` here. It waits on EVERY background job, so a child that is
  # slow to die (or already reaped) hangs the script at exit — which looks
  # exactly like the recording never finishing.
  for pid in $(printf '%s\n' "${pids[@]:-}" | tac); do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  "$repo_root/scripts/rmrf.sh" "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- build

step "Building the web UI"
# The daemon serves the built SPA, not the Vite dev server: the video should
# show what a user gets from npm, and the dev server's overlays and HMR
# banners have no business on camera.
#
# SKIP_BUILD=1 when dist/ is already current. Worth using: a full rebuild
# rewrites every package's dist, and if this repo sits under a running
# daemon's watchRoots that is a burst of file events for someone else's UI.
if [ "${SKIP_BUILD:-0}" = "1" ] && [ -f packages/daemon/dist/index.js ]; then
  echo "    skipped (SKIP_BUILD=1)"
else
  bun run build >/dev/null
fi

step "Building the demo repo"
REPO="$("$repo_root/scripts/demo/fixture.sh")"
echo "    $REPO"

# ---------------------------------------------------------------- stage

step "Starting Xvfb on $DISPLAY_NUM (${WIDTH}x${HEIGHT})"
Xvfb "$DISPLAY_NUM" -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp &
pids+=($!)
sleep 1

step "Starting diffstalkerd on 127.0.0.1:$DEMO_PORT"
# --no-socket + --no-follow: this daemon must not bind the user's real socket
# and must not react to their shell hook mid-take.
XDG_CONFIG_HOME="$WORK/config" \
  node packages/daemon/dist/index.js --no-socket --port "$DEMO_PORT" --no-follow \
  >"$WORK/daemon.log" 2>&1 &
pids+=($!)

for _ in $(seq 40); do
  curl -sf "http://127.0.0.1:$DEMO_PORT/health" >/dev/null && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:$DEMO_PORT/health" >/dev/null || {
  echo "daemon did not come up:" >&2; cat "$WORK/daemon.log" >&2; exit 1
}

step "Opening Chrome on the Changes tab"
# The take opens where a working session opens: Changes, on a clean tree, with
# nothing in it. Everything that appears after this is written while the camera
# is running.
URL="http://127.0.0.1:$DEMO_PORT/changes${REPO}"
echo "    $URL"

# --app with the REAL url. It has to be a real one: Chrome rejects
# --app=about:blank and falls back to a normal window, putting a tab strip
# and an address bar (showing this very path) on camera. choreograph.ts
# navigates here again after seeding the display prefs, which is same-origin
# and so keeps the app window.
DISPLAY="$DISPLAY_NUM" google-chrome-stable \
  --app="$URL" \
  --user-data-dir="$WORK/chrome" \
  --remote-debugging-port="$CDP_PORT" \
  --window-position=0,0 \
  --window-size="$WIDTH,$HEIGHT" \
  --force-device-scale-factor=1 \
  --no-first-run --no-default-browser-check --disable-sync \
  --disable-features=Translate,MediaRouter \
  >"$WORK/chrome.log" 2>&1 &
pids+=($!)

# ---------------------------------------------------------------- take

step "Cueing the choreography"
# choreograph.ts prints "ready" once Compare has actually rendered, then
# blocks on stdin. That gap is where the camera starts, so the opening frame
# is the finished view and never a spinner.
mkfifo "$WORK/cue"
# DEMO_REPO: the choreography edits a file on disk mid-take, so the view can
# be seen refreshing itself. That is the one claim a screenshot cannot make.
DEMO_REPO="$REPO" \
  bun scripts/demo/choreograph.ts "$CDP_PORT" "$URL" <"$WORK/cue" >"$WORK/ready" &
choreo=$!
exec 3>"$WORK/cue"

for _ in $(seq 120); do
  grep -q ready "$WORK/ready" 2>/dev/null && break
  kill -0 "$choreo" 2>/dev/null || { echo "choreography died" >&2; exit 1; }
  sleep 0.25
done
grep -q ready "$WORK/ready" 2>/dev/null || { echo "compare never rendered" >&2; exit 1; }

step "Recording"
# Lossless here, encoded later: one take, many outputs, and no generation
# loss from re-encoding an already-compressed capture.
ffmpeg -hide_banner -loglevel error -y \
  -f x11grab -draw_mouse 0 -framerate "$FPS" -video_size "${WIDTH}x${HEIGHT}" \
  -i "$DISPLAY_NUM.0" \
  -c:v libx264rgb -crf 0 -preset ultrafast \
  "$OUT/raw.mkv" </dev/null &
ffmpeg_pid=$!
# Deliberately NOT in `pids`: it is stopped explicitly below, and a SECOND
# signal makes ffmpeg abandon the trailer ("Error writing trailer: Immediate
# exit requested") — which leaves a file no player will open.

sleep 0.6          # let the first frames land before anything moves
echo go >&3        # release the choreography
wait "$choreo"     # ... and let it run the whole script

sleep 0.4
step "Closing the file"
# One INT, then give it time to write the trailer before escalating.
kill -INT "$ffmpeg_pid" 2>/dev/null || true
for _ in $(seq 100); do
  kill -0 "$ffmpeg_pid" 2>/dev/null || break
  sleep 0.1
done
kill -0 "$ffmpeg_pid" 2>/dev/null && kill -TERM "$ffmpeg_pid" 2>/dev/null
wait "$ffmpeg_pid" 2>/dev/null || true
exec 3>&-

step "Recorded $OUT/raw.mkv"
ls -lh "$OUT/raw.mkv" | awk '{print "    " $5}'
echo
echo "Next: scripts/demo/encode.sh"
