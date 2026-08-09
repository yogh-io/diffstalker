/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "extract-only-in-worker",
      comment:
        "The tree-sitter engine blocks its thread and can be poisoned by a cancelled parse. It runs ONLY inside symbolWorker.ts, which the host discards and respawns on any failure. A main-thread import would put a multi-second query and a corruptible wasm instance on the daemon's event loop, where SSE keep-alives, follow mode and every other repo live.",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/symbols/symbolWorker\\.ts$" },
      to: { path: "@diffstalker/core/symbols/extract|/core/(src|dist)/symbols/extract" },
    },
    // --- Layering: index -> server -> routes/ -> follow -> router/registry/sse/serialize -> core ---
    {
      name: "serialize-bottom-layer",
      comment: "serialize.ts is the bottom layer; it only imports core",
      severity: "error",
      from: { path: "^src/serialize\\.ts$" },
      to: { path: "^src/(index|server|router|repoRegistry|sse|follow)\\.ts$|^src/routes/" },
    },
    {
      name: "registry-no-upper-layers",
      comment: "repoRegistry.ts must not import server/routes/router/follow/index",
      severity: "error",
      from: { path: "^src/repoRegistry\\.ts$" },
      to: { path: "^src/(index|server|router|follow)\\.ts$|^src/routes/" },
    },
    {
      name: "sse-no-upper-layers",
      comment: "sse.ts must not import server/routes/router/follow/index",
      severity: "error",
      from: { path: "^src/sse\\.ts$" },
      to: { path: "^src/(index|server|router|follow)\\.ts$|^src/routes/" },
    },
    {
      name: "follow-no-upper-layers",
      comment: "follow.ts sits below routes/: only registry/sse/core imports",
      severity: "error",
      from: { path: "^src/follow\\.ts$" },
      to: { path: "^src/(index|server|router|serialize)\\.ts$|^src/routes/" },
    },
    {
      name: "settings-bottom-layer",
      comment:
        "settings.ts is a file-backed document; it only imports core. No registry, no routes, no server.",
      severity: "error",
      from: { path: "^src/settings\\.ts$" },
      to: {
        path: "^src/(index|server|router|repoRegistry|sse|follow|discovery)\\.ts$|^src/routes/",
      },
    },
    {
      name: "discovery-no-upper-layers",
      comment: "discovery.ts sits beside follow.ts, below routes/: only sse/core imports",
      severity: "error",
      from: { path: "^src/discovery\\.ts$" },
      to: { path: "^src/(index|server|router|serialize|repoRegistry)\\.ts$|^src/routes/" },
    },
    {
      name: "staticfiles-no-upper-layers",
      comment: "staticFiles.ts sits at the router layer: only router/core imports",
      severity: "error",
      from: { path: "^src/staticFiles\\.ts$" },
      to: { path: "^src/(index|server|repoRegistry|sse|follow)\\.ts$|^src/routes/" },
    },
    {
      name: "router-no-upper-layers",
      comment: "router.ts is generic; no server/routes/index/registry/sse/follow imports",
      severity: "error",
      from: { path: "^src/router\\.ts$" },
      to: { path: "^src/(index|server|repoRegistry|sse|follow|staticFiles)\\.ts$|^src/routes/" },
    },
    {
      name: "routes-no-upper-layers",
      comment: "route modules must not import server.ts or the entry point",
      severity: "error",
      from: { path: "^src/routes/" },
      to: { path: "^src/(index|server)\\.ts$" },
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
