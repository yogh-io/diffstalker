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
provides=('diffstalker')
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
    bun run build:prod
    # Tree-shake everything except neo-blessed (which has dynamic requires)
    bun build dist/index.js --outdir dist/bundle --minify --target node --external neo-blessed
}

package() {
    cd "$pkgname"

    # Install to /usr/lib/diffstalker (~2MB total)
    install -dm755 "$pkgdir/usr/lib/diffstalker"
    cp dist/bundle/index.js "$pkgdir/usr/lib/diffstalker/"
    # Only neo-blessed needed at runtime (everything else is bundled)
    mkdir -p "$pkgdir/usr/lib/diffstalker/node_modules"
    cp -r node_modules/neo-blessed "$pkgdir/usr/lib/diffstalker/node_modules/"

    # Create wrapper script
    install -dm755 "$pkgdir/usr/bin"
    cat > "$pkgdir/usr/bin/diffstalker" << 'EOF'
#!/bin/sh
exec node /usr/lib/diffstalker/index.js "$@"
EOF
    chmod 755 "$pkgdir/usr/bin/diffstalker"

    # Install license and documentation
    install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
    install -Dm644 README.md "$pkgdir/usr/share/doc/$pkgname/README.md"
}
