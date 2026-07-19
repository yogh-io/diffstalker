/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // --- Layering: index -> server -> routes/router -> registry/sse/serialize -> core ---
    {
      name: "serialize-bottom-layer",
      comment: "serialize.ts is the bottom layer; it only imports core",
      severity: "error",
      from: { path: "^src/serialize\\.ts$" },
      to: { path: "^src/(index|server|router|repoRegistry|sse)\\.ts$" },
    },
    {
      name: "registry-no-upper-layers",
      comment: "repoRegistry.ts must not import server/router/index",
      severity: "error",
      from: { path: "^src/repoRegistry\\.ts$" },
      to: { path: "^src/(index|server|router)\\.ts$" },
    },
    {
      name: "sse-no-upper-layers",
      comment: "sse.ts must not import server/router/index",
      severity: "error",
      from: { path: "^src/sse\\.ts$" },
      to: { path: "^src/(index|server|router)\\.ts$" },
    },
    {
      name: "router-no-upper-layers",
      comment: "router.ts is generic; no server/index/registry/sse imports",
      severity: "error",
      from: { path: "^src/router\\.ts$" },
      to: { path: "^src/(index|server|repoRegistry|sse)\\.ts$" },
    },
    {
      name: "server-no-index",
      comment: "server.ts must not import the entry point",
      severity: "error",
      from: { path: "^src/server\\.ts$" },
      to: { path: "^src/index\\.ts$" },
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
