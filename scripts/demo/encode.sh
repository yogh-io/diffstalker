#!/usr/bin/env bash
# scripts/demo/encode.sh — turn the lossless take into the things you post.
#
# One capture, three outputs, because the places you post want different
# files: an MP4 for Reddit/HN/Bluesky, a GIF for the README (GitHub will not
# play an MP4 from a raw URL, only from an upload), and a still for a social
# card or the top of the README.
#
# The GIF is the fussy one. Screen recordings are mostly static pixels with
# small moving regions, so a per-scene palette (stats_mode=diff) spends its
# 256 colours on what actually changes instead of averaging the whole frame.
# Even so, GIF is a bad video codec: keep it narrow and short, and check the
# size it prints.
#
# Usage: scripts/demo/encode.sh [raw.mkv]
# Tunables: GIF_WIDTH=900  GIF_FPS=15  POSTER_AT=00:00:02
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$repo_root/scripts/demo/out"
RAW="${1:-$OUT/raw.mkv}"

GIF_WIDTH="${GIF_WIDTH:-900}"
GIF_FPS="${GIF_FPS:-15}"
# The GIF is a CUT, not the whole take: a README wants the shortest loop that
# still makes the point, and GIF pays for every extra second in megabytes.
# Empty GIF_DURATION means the whole thing.
GIF_START="${GIF_START:-0}"
GIF_DURATION="${GIF_DURATION:-}"
POSTER_AT="${POSTER_AT:-00:00:02}"

[ -f "$RAW" ] || { echo "no capture at $RAW — run scripts/demo/record.sh first" >&2; exit 1; }

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
size() { du -h "$1" | cut -f1; }

step "MP4 (social, PRs, Reddit)"
# yuv420p and the /2 crop: some players still refuse odd dimensions or
# anything but 4:2:0 chroma, and silently show nothing rather than erroring.
ffmpeg -hide_banner -loglevel error -y -i "$RAW" \
  -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" \
  -c:v libx264 -profile:v high -crf 20 -preset slow -pix_fmt yuv420p \
  -movflags +faststart -an \
  "$OUT/compare.mp4"
echo "    $OUT/compare.mp4  ($(size "$OUT/compare.mp4"))"

step "GIF (README)"
palette="$(mktemp /tmp/diffstalker-demo-palette.XXXXXX.png)"
filters="fps=$GIF_FPS,scale=$GIF_WIDTH:-1:flags=lanczos"

cut=(-ss "$GIF_START")
[ -n "$GIF_DURATION" ] && cut+=(-t "$GIF_DURATION")

# Two passes over the SAME cut: the palette has to be built from the frames
# it will be applied to, or the colours drift.
ffmpeg -hide_banner -loglevel error -y "${cut[@]}" -i "$RAW" \
  -vf "$filters,palettegen=stats_mode=diff" "$palette"
ffmpeg -hide_banner -loglevel error -y "${cut[@]}" -i "$RAW" -i "$palette" \
  -lavfi "$filters [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -loop 0 "$OUT/compare.gif"
"$repo_root/scripts/rmrf.sh" "$palette"

gif_bytes="$(stat -c %s "$OUT/compare.gif")"
echo "    $OUT/compare.gif  ($(size "$OUT/compare.gif"))"
if [ "$gif_bytes" -gt 10485760 ]; then
  echo "    NOTE: over 10MB. Drop GIF_WIDTH to 800 or GIF_FPS to 12, or cut the take shorter."
fi

step "Poster frame"
ffmpeg -hide_banner -loglevel error -y -ss "$POSTER_AT" -i "$RAW" -frames:v 1 \
  "$OUT/compare-poster.png"
echo "    $OUT/compare-poster.png  ($(size "$OUT/compare-poster.png"))"

step "Done"
