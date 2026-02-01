#!/usr/bin/env bash
# tmux-test.sh - Testing helper for diffstalker
# Manages a tmux session for headless UI testing
#
# Usage:
#   Single command:  scripts/tmux-test.sh start
#   Chained:         scripts/tmux-test.sh start : keys j : capture : kill
#   Repeat key:      scripts/tmux-test.sh keys j 5 : capture
#   Wait:            scripts/tmux-test.sh wait 1 : capture
#
# Commands: start, keys <key> [count], wait <seconds>, capture, kill, status

set -e

SESSION="difftest"
WIDTH=100
HEIGHT=24

run_cmd() {
  case "$1" in
    start)
      tmux kill-session -t "$SESSION" 2>/dev/null || true
      tmux new-session -d -s "$SESSION" -x "$WIDTH" -y "$HEIGHT" 'bun run dev'
      sleep 2
      ;;
    keys)
      if [ -z "$2" ]; then
        echo "Usage: keys <key> [count]" >&2
        exit 1
      fi
      local count="${3:-1}"
      for ((i=0; i<count; i++)); do
        tmux send-keys -t "$SESSION" "$2"
        sleep 0.025
      done
      ;;
    wait)
      sleep "${2:-1}"
      ;;
    capture)
      tmux capture-pane -t "$SESSION" -p
      ;;
    kill)
      tmux kill-session -t "$SESSION" 2>/dev/null || true
      ;;
    status)
      if tmux has-session -t "$SESSION" 2>/dev/null; then
        echo "Session '$SESSION' is running"
      else
        echo "Session '$SESSION' is not running"
        return 1
      fi
      ;;
    *)
      echo "Unknown command: $1" >&2
      echo "Commands: start, keys <key> [count], wait <seconds>, capture, kill, status" >&2
      exit 1
      ;;
  esac
}

# No args - show usage
if [ $# -eq 0 ]; then
  echo "Usage: $0 <command> [args] [: <command> [args] ...]" >&2
  echo "Commands: start, keys <key>, capture, kill, status" >&2
  exit 1
fi

# Process commands, splitting on ":"
cmd=""
arg=""
arg2=""
for token in "$@"; do
  if [ "$token" = ":" ]; then
    # Execute accumulated command
    if [ -n "$cmd" ]; then
      run_cmd "$cmd" "$arg" "$arg2"
    fi
    cmd=""
    arg=""
    arg2=""
  elif [ -z "$cmd" ]; then
    cmd="$token"
  elif [ -z "$arg" ]; then
    arg="$token"
  else
    arg2="$token"
  fi
done

# Execute final command
if [ -n "$cmd" ]; then
  run_cmd "$cmd" "$arg" "$arg2"
fi
