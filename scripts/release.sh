#!/bin/sh
set -e

# Usage: scripts/release.sh [patch|minor|major]
# Defaults to patch if no argument given.

bump="${1:-patch}"

case "$bump" in
  patch|minor|major) ;;
  *) echo "Usage: $0 [patch|minor|major]" >&2; exit 1 ;;
esac

# Single source of version truth: the ROOT package.json. Everything derives from
# it. The two PUBLISHED manifests (cli, daemon) are bumped in lockstep to the same
# version — npm needs a literal version in each, and the cli depends on diffstalkerd
# via workspace:* (published as the exact version), so any skew would ship an
# uninstallable cli. The private, bundled packages (core/client/web) are NOT here:
# they carry a static 0.0.0 and are never versioned (they ship inside the published
# bundles, never on their own). If the web ever becomes independently publishable,
# add its manifest here.
MANIFESTS="package.json packages/cli/package.json packages/daemon/package.json"

# Ensure clean working tree
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: working tree is not clean" >&2
  exit 1
fi

# Release from main only. The CI release workflow pushes the metrics snapshot to
# main (`git push origin HEAD:main`); cutting a release from any other branch
# would put the tagged commit off main's history and wedge that push.
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "Error: release from main only (currently on '$branch')" >&2
  exit 1
fi

# Sync with origin/main before releasing. CI pushes a metrics-snapshot commit to
# main after every publish, so local main is one commit behind after each release;
# without this, the `git push origin main` below would be rejected (non-fast-forward).
git pull --rebase origin main

# Read current version from the single source of truth (root package.json).
current=$(node -p "require('./package.json').version")

# Compute next version
IFS='.' read -r ma mi pa <<EOF
$current
EOF

case "$bump" in
  patch) pa=$((pa + 1)) ;;
  minor) mi=$((mi + 1)); pa=0 ;;
  major) ma=$((ma + 1)); mi=0; pa=0 ;;
esac
next="$ma.$mi.$pa"

# Require a changelog entry for the version being released
if ! grep -q "^## \[$next\]" CHANGELOG.md; then
  echo "Error: CHANGELOG.md has no entry for $next" >&2
  exit 1
fi

echo "$current -> $next"

# Bump every published manifest to the same version (see MANIFESTS above).
for manifest in $MANIFESTS; do
  node -e "
    const fs = require('fs');
    const p = '$manifest';
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    pkg.version = '$next';
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  "
done

# Keep bun.lock's workspace versions in lockstep with the bumped manifests.
# CRITICAL: `bun pm pack` derives the published cli's `diffstalkerd` pin from the
# LOCKFILE, not the manifest — a stale lockfile ships a wrong-version pin (0.5.0
# shipped pinning diffstalkerd@0.4.0 this way). Patch only the workspace "version"
# fields that currently hold the OUTGOING version ($current) — that's cli + daemon
# (bun.lock has no version field for the root workspace entry). The private,
# bundled packages (core/client/web) sit at a static 0.0.0 and are deliberately
# left untouched, so no lock/manifest drift is created. Because this patch is
# equality-scoped it would SILENTLY SKIP a stale cli/daemon entry, so it then
# asserts both landed at $next and refuses otherwise — catching the bad pin here,
# before the tag is pushed, not just at CI's post-push pin-guard.
next="$next" current="$current" node -e '
  const fs = require("fs");
  const { next, current } = process.env;
  const p = "bun.lock";
  const s = fs.readFileSync(p, "utf8");
  const i = s.indexOf("\n  \"packages\": {");
  if (i < 0) { console.error("bun.lock: workspaces/packages boundary not found"); process.exit(1); }
  const head = s.slice(0, i).replace(
    /("version": ")([^"]*)(")/g,
    (m, a, ver, b) => (ver === current ? a + next + b : m)
  );
  const lockVersion = (key) => {
    const k = head.indexOf(`"${key}": {`);
    if (k < 0) return null;
    const marker = `"version": "`;
    const v = head.indexOf(marker, k);
    if (v < 0) return null;
    const start = v + marker.length;
    return head.slice(start, head.indexOf(`"`, start));
  };
  for (const key of ["packages/cli", "packages/daemon"]) {
    const got = lockVersion(key);
    if (got !== next) {
      console.error(`bun.lock: ${key} is ${got}, expected ${next} (stale lock entry?) — refusing`);
      process.exit(1);
    }
  }
  fs.writeFileSync(p, head + s.slice(i));
'

# Commit, tag, push. Push main explicitly (not via the branch's upstream) so it
# matches the CI tail's `HEAD:main` and never fails on a missing upstream.
git add $MANIFESTS bun.lock
git commit -m "Bump version to $next"
git tag "v$next"
git push origin main
git push origin "v$next"
