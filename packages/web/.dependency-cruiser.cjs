/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // --- Browser safety: this package runs in the browser, full stop ---
    {
      name: "no-node-builtins",
      comment:
        "Web code runs in the browser: no Node builtins (node:fs, path, http, ...)",
      severity: "error",
      from: { path: "^src/" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "no-core-managers",
      comment:
        "The web UI is a pure daemon client: core's EventEmitter managers are daemon-side only",
      severity: "error",
      from: { path: "^src/" },
      // Match both the bare specifier and any resolved dist/src path. Today
      // dependency-cruiser can't resolve core's exports-map subpaths, so the
      // ban lands on the raw specifier; the second alternative keeps it firing
      // if a future resolver expands it to a real path.
      to: { path: "@diffstalker/core/managers|/core/(src|dist)/managers/" },
    },
    {
      name: "no-in-process-git",
      comment:
        "simple-git and chokidar are core/daemon-only (and Node-only anyway). Match the bare specifier too: until slice 3 pulls @diffstalker/core (which depends on them) these aren't installed under web, so they stay unresolved — a node_modules-only regex would match nothing and pass vacuously.",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^(simple-git|chokidar)$|node_modules/(simple-git|chokidar)/" },
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
