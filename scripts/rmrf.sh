#!/usr/bin/env bash
# scripts/rmrf.sh — the ONE formalized "remove a directory/file hierarchy" operation.
#
# Why this exists: builds, temp git fixtures, sockets, and scratch dirs need deleting.
# Instead of ad-hoc `rm -rf` (which triggers a permission prompt) or workarounds that do
# the same thing through a side door (python shutil.rmtree, find -delete, etc.), call THIS
# script. It is permissioned once in .claude/settings.local.json, so it never prompts, and
# it is SAFE by construction: it only removes paths under the repo root, a tmp dir, or
# $XDG_RUNTIME_DIR — and never those roots themselves. Everything else is refused.
#
# Usage: scripts/rmrf.sh <path> [path...]
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/rmrf.sh <path> [path...]" >&2
  exit 2
fi

for target in "$@"; do
  # Resolve to an absolute path without requiring the target to exist.
  abs="$(realpath -m -- "$target")"

  # Never remove a root-ish path, even if it is otherwise in-scope.
  case "$abs" in
    / | "$HOME" | "$repo_root" | /tmp | /var/tmp | "${XDG_RUNTIME_DIR:-/__none__}")
      echo "rmrf: refusing to remove root-ish path: $abs" >&2
      exit 1
      ;;
  esac

  # Only allow removals strictly inside the repo, a tmp dir, or the runtime dir.
  case "$abs" in
    "$repo_root"/* | /tmp/* | /var/tmp/* | "${XDG_RUNTIME_DIR:-/__none__}"/*)
      rm -rf -- "$abs"
      ;;
    *)
      echo "rmrf: refusing out-of-scope path: $abs (allowed: repo, /tmp, \$XDG_RUNTIME_DIR)" >&2
      exit 1
      ;;
  esac
done
