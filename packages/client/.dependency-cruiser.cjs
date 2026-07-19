/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // --- Layering: index -> client -> transport, wire types at the bottom ---
    {
      name: "client-no-index",
      comment: "client.ts must not import the entry point",
      severity: "error",
      from: { path: "^src/client\\.ts$" },
      to: { path: "^src/index\\.ts$" },
    },
    {
      name: "transport-bottom-layer",
      comment: "transport.ts is the bottom layer; no internal imports",
      severity: "error",
      from: { path: "^src/transport\\.ts$" },
      to: { path: "^src/(index|client|wire)\\.ts$" },
    },
    {
      name: "wire-types-only",
      comment: "wire.ts holds wire types; no internal imports",
      severity: "error",
      from: { path: "^src/wire\\.ts$" },
      to: { path: "^src/(index|client|transport)\\.ts$" },
    },

    // --- Runtime purity: the client ships node builtins only ---
    {
      name: "no-daemon-runtime",
      comment:
        "@diffstalker/daemon is a dev-dep for tests only; the shipped client must never import it",
      severity: "error",
      from: { path: "^src/", pathNot: "\\.test\\.ts$" },
      to: { path: "@diffstalker/daemon" },
    },
    {
      name: "no-core-runtime",
      comment:
        "@diffstalker/core is type-only for the shipped client (DTO shapes); runtime imports are forbidden",
      severity: "error",
      from: { path: "^src/", pathNot: "\\.test\\.ts$" },
      to: { path: "@diffstalker/core", dependencyTypesNot: ["type-only"] },
    },

    // --- No circular dependencies ---
    {
      name: "no-circular",
      comment: "No circular dependencies allowed",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
  },
};
