#!/bin/sh
set -e

# Usage: scripts/release.sh [patch|minor|major]
# Defaults to patch if no argument given.

bump="${1:-patch}"

case "$bump" in
  patch|minor|major) ;;
  *) echo "Usage: $0 [patch|minor|major]" >&2; exit 1 ;;
esac

# Ensure clean working tree
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: working tree is not clean" >&2
  exit 1
fi

# Read current version (published package lives in packages/cli)
current=$(node -p "require('./packages/cli/package.json').version")

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

# Update BOTH published manifests to the same version. They release in
# lockstep: the cli depends on diffstalkerd via workspace:* (published as the
# exact version), so a version skew would ship an uninstallable cli.
for manifest in packages/cli/package.json packages/daemon/package.json; do
  node -e "
    const fs = require('fs');
    const p = '$manifest';
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    pkg.version = '$next';
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  "
done

# Commit, tag, push
git add packages/cli/package.json packages/daemon/package.json
git commit -m "Bump version to $next"
git tag "v$next"
git push
git push origin "v$next"
