# Maintainer: yogh-io <info@yogh.nl>
pkgname=diffstalker-git
# Placeholder: pkgver() rewrites this from `git describe` on every build.
pkgver=0.1.0.r0.g0000000
pkgrel=1
pkgdesc="Terminal UI for git staging, committing, and reviewing changes"
arch=('any')
url="https://github.com/yogh-io/diffstalker"
license=('MIT')
depends=('nodejs' 'git')
makedepends=('bun' 'git')
provides=('diffstalker' 'diffstalkerd')
conflicts=('diffstalker' 'diffstalkerd')
source=("${pkgname}::git+${url}.git")
sha256sums=('SKIP')

pkgver() {
    cd "$pkgname"
    git describe --long --tags --abbrev=7 2>/dev/null | sed 's/^v//;s/\([^-]*-g\)/r\1/;s/-/./g' ||
    printf "0.1.0.r%s.g%s" "$(git rev-list --count HEAD)" "$(git rev-parse --short=7 HEAD)"
}

# The paths this package puts on PATH. `npm install -g diffstalker` and
# `npm link` both plant unowned files here — npm's prefix on Arch is /usr — and
# pacman aborts the whole transaction on any file it does not own ("exists in
# filesystem"). That check runs ahead of every install scriptlet and hook, so a
# .install file cannot clear the way; build time is the only point where this
# package still gets to say something, and it is at least ahead of the failure.
_pathbins=(/usr/bin/diffstalker /usr/bin/diffstalkerd)

_warn() {
    if declare -F warning >/dev/null; then
        warning '%s' "$1"
    else
        printf '==> WARNING: %s\n' "$1" >&2
    fi
}

_check_foreign_bins() {
    local p target foreign=()
    for p in "${_pathbins[@]}"; do
        # -e alone is false for a dangling symlink, which is exactly what a
        # stale `npm link` leaves once its target moves. Test -L as well or the
        # most common case slips through unnoticed.
        [[ -e $p || -L $p ]] || continue
        pacman -Qo -- "$p" &>/dev/null || foreign+=("$p")
    done
    (( ${#foreign[@]} )) || return 0

    _warn "No package owns these paths, so pacman will refuse to install over them:"
    for p in "${foreign[@]}"; do
        if target=$(readlink -- "$p"); then _warn "    $p -> $target"; else _warn "    $p"; fi
    done
    _warn "Almost always a leftover npm global install or 'npm link'. Clear it with:"
    _warn "    sudo npm rm -g diffstalker diffstalkerd     # tidies node_modules too"
    _warn "    sudo rm ${foreign[*]}"
    _warn "Or let pacman take the paths over: --overwrite '/usr/bin/diffstalker*'"
    return 0
}

prepare() {
    # Once here, before the multi-minute build, and once more at the end of
    # package() where it is the last thing printed before pacman's transaction.
    _check_foreign_bins
}

# Runtime dependencies, staged as a tree of real directories.
#
# The workspace install links every package into a shared store
# (node_modules/.bun/<pkg>@<ver>), so packages/*/node_modules holds symlinks
# that would land in $pkgdir dangling. A separate production install of the
# package's own declared dependencies — the same set npm consumers get — with
# the hoisted linker produces real directories instead, transitive deps
# included. Versions are pinned to whatever the workspace install resolved, so
# what ships matches what this build compiled against.
_stage_runtime_deps() {
    local pkg="$1" stage="$srcdir/runtime/$(basename "$1")"
    install -dm755 "$stage"
    node -e '
      const fs = require("node:fs");
      const [pkgDir, outDir] = process.argv.slice(1);
      const read = (p) => JSON.parse(fs.readFileSync(p, "utf-8"));
      const dependencies = {};
      for (const [name, range] of Object.entries(read(pkgDir + "/package.json").dependencies ?? {})) {
        // Workspace siblings are bundled into dist/ (core, client) or shipped
        // as their own bin (diffstalkerd) — never installed as a dependency.
        if (range.startsWith("workspace:")) continue;
        dependencies[name] = read(pkgDir + "/node_modules/" + name + "/package.json").version;
      }
      fs.writeFileSync(outDir + "/package.json",
        JSON.stringify({ name: "diffstalker-runtime", version: "0.0.0", private: true, dependencies }));
    ' "$PWD/$pkg" "$stage"
    ( cd "$stage" && bun install --production --linker hoisted )
}

build() {
    cd "$pkgname"
    bun install
    # Two published packages: the terminal UI (diffstalker) and the git-state
    # daemon it spawns (diffstalkerd). Ship both, each from its build:prod
    # bundle (dist/index.js). No divergent second bun build — the same output
    # npm consumers get.
    ( cd packages/cli && bun run build:prod )
    ( cd packages/daemon && bun run build:prod )

    _stage_runtime_deps packages/cli
    _stage_runtime_deps packages/daemon
}

# Install one built component in the layout npm publishes: dist/index.js beside
# a package.json, node_modules alongside. That layout is load-bearing — the
# bundles are ESM, so Node needs "type": "module" in a package.json above them;
# the daemon reads ../package.json for the version it reports to clients, and
# serves the web UI from web/ next to its own module. Flattening dist/ away
# breaks all three.
_install_component() {
    local pkg="$1" dir="$2" name="$3"
    local dest="$pkgdir/usr/lib/diffstalker/$dir" version
    version=$(node -p "require('$PWD/$pkg/package.json').version")

    install -Dm644 "$pkg/dist/index.js" "$dest/dist/index.js"
    printf '{\n  "name": "%s",\n  "version": "%s",\n  "type": "module",\n  "private": true\n}\n' \
        "$name" "$version" > "$dest/package.json"
    chmod 644 "$dest/package.json"

    install -dm755 "$dest/node_modules"
    cp -r "$srcdir/runtime/$dir/node_modules/." "$dest/node_modules/"
    rm -rf "$dest/node_modules/.bin" "$dest/node_modules/.cache"
}

package() {
    cd "$pkgname"

    _install_component packages/cli cli diffstalker
    _install_component packages/daemon daemon diffstalkerd

    # Web UI assets: the daemon serves the SPA at GET / from web/ next to its
    # own module, which build:prod placed at dist/web.
    cp -r packages/daemon/dist/web "$pkgdir/usr/lib/diffstalker/daemon/dist/"

    # Wrapper bins on PATH. The TUI cannot resolve diffstalkerd from its own
    # node_modules here (it is a separate bin, not a bundled dependency), so it
    # falls through to PATH and spawns this wrapper on a unix socket.
    install -dm755 "$pkgdir/usr/bin"
    cat > "$pkgdir/usr/bin/diffstalker" << 'EOF'
#!/usr/bin/env node
import('/usr/lib/diffstalker/cli/dist/index.js').catch((e) => {
  console.error(e);
  process.exit(1);
});
EOF
    cat > "$pkgdir/usr/bin/diffstalkerd" << 'EOF'
#!/usr/bin/env node
import('/usr/lib/diffstalker/daemon/dist/index.js').catch((e) => {
  console.error(e);
  process.exit(1);
});
EOF
    chmod 755 "$pkgdir/usr/bin/diffstalker" "$pkgdir/usr/bin/diffstalkerd"

    # TODO (Phase 6 deferred): ship systemd user units for socket-activated
    # diffstalkerd (see packages/daemon/README.md) instead of relying on the
    # TUI to spawn it.

    install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
    install -Dm644 README.md "$pkgdir/usr/share/doc/$pkgname/README.md"

    # Last word before pacman commits, so the remedy is still on screen when
    # the "exists in filesystem" error lands a few lines further down.
    _check_foreign_bins
}
