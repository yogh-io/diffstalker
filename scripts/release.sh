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

# Read current version
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

echo "$current -> $next"

# Update package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '$next';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Commit, tag, push
git add package.json
git commit -m "Bump version to $next"
git tag "v$next"
git push
git push origin "v$next"
