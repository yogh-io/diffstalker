/**
 * Root (workspace-wide) dependency-cruiser config: a backstop that the
 * per-package configs cannot provide.
 *
 * Each `packages/<pkg>/.dependency-cruiser.cjs` scans only that package's
 * `src/` and sees `@diffstalker/*` imports as external node_modules — so a
 * cycle that spans packages (e.g. core → client → core) slips past all of
 * them. This config scans the workspace packages together and resolves the
 * `@diffstalker/*` subpath imports back to each package's `src/`, so a
 * circular dependency ANYWHERE in the graph — within a package or across
 * the workspace — is an error.
 *
 * Run with `bun run deps:workspace`. The `web` package is intentionally not
 * scanned here: it is a leaf consumer (nothing imports it), so it cannot be
 * part of a cross-package cycle, and its Vue SFCs are already covered by its
 * own per-package no-circular rule.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'No circular dependencies — within a package OR across the workspace',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    // tsconfig.deps.json maps @diffstalker/* subpath imports to each
    // package's src/, so cross-package edges resolve to real files (and
    // NodeNext `.js` specifiers map to their `.ts` source).
    tsConfig: { fileName: 'tsconfig.deps.json' },
    doNotFollow: { path: 'node_modules' },
  },
};
