# Maintainer: yogh-io <info@yogh.nl>
pkgname=diffstalker-git
pkgver=0.1.0.r0.g0000000
pkgrel=1
pkgdesc="Terminal UI for git staging, committing, and reviewing changes"
arch=('any')
url="https://github.com/yogh-io/diffstalker"
license=('MIT')
depends=('nodejs')
makedepends=('bun' 'git')
provides=('diffstalker' 'diffstalkerd')
conflicts=('diffstalker')
source=("${pkgname}::git+${url}.git")
sha256sums=('SKIP')

pkgver() {
    cd "$pkgname"
    git describe --long --tags --abbrev=7 2>/dev/null | sed 's/^v//;s/\([^-]*-g\)/r\1/;s/-/./g' ||
    printf "0.1.0.r%s.g%s" "$(git rev-list --count HEAD)" "$(git rev-parse --short=7 HEAD)"
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
}

# Dev-only node_modules entries to drop from the runtime install. build:prod
# bundles everything into dist/index.js except a handful of externals (packages
# with dynamic requires / native bits); those externals plus their runtime
# transitive deps must ship, but the toolchain must not.
_devmodules=(eslint '@eslint' '@typescript-eslint' typescript-eslint typescript
    prettier eslint-config-prettier eslint-plugin-sonarjs dependency-cruiser
    '@types' '@diffstalker' diffstalkerd '@diffstalker/client' '.bin' '.cache')

_install_runtime_modules() {
    # $1 = source package dir, $2 = destination lib dir. Copies the resolved
    # node_modules tree (external runtime deps + their transitive deps, which
    # bun flattens here) minus the dev toolchain, next to the bundle so Node's
    # upward module resolution finds them.
    local src="$1/node_modules" dst="$2/node_modules"
    install -dm755 "$dst"
    cp -r "$src/." "$dst/"
    for m in "${_devmodules[@]}"; do
        rm -rf "${dst:?}/$m"
    done
}

package() {
    cd "$pkgname"

    install -dm755 "$pkgdir/usr/lib/diffstalker/cli" "$pkgdir/usr/lib/diffstalker/daemon"
    install -m644 packages/cli/dist/index.js "$pkgdir/usr/lib/diffstalker/cli/index.js"
    install -m644 packages/daemon/dist/index.js "$pkgdir/usr/lib/diffstalker/daemon/index.js"

    # Web UI assets. The daemon serves the SPA at GET / from web/ next to its
    # own module (resolveWebRoot); build:prod placed them at dist/web.
    install -dm755 "$pkgdir/usr/lib/diffstalker/daemon/web"
    cp -r packages/daemon/dist/web/. "$pkgdir/usr/lib/diffstalker/daemon/web/"

    _install_runtime_modules packages/cli "$pkgdir/usr/lib/diffstalker/cli"
    _install_runtime_modules packages/daemon "$pkgdir/usr/lib/diffstalker/daemon"

    # Wrapper bins on PATH. The TUI finds the daemon via PATH (diffstalkerd)
    # and spawns it automatically on a unix socket.
    install -dm755 "$pkgdir/usr/bin"
    cat > "$pkgdir/usr/bin/diffstalker" << 'EOF'
#!/usr/bin/env node
import('/usr/lib/diffstalker/cli/index.js');
EOF
    cat > "$pkgdir/usr/bin/diffstalkerd" << 'EOF'
#!/usr/bin/env node
import('/usr/lib/diffstalker/daemon/index.js').catch((e) => {
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
}
