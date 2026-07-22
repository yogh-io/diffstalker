/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // --- Bottom layer: git/, utils/, services/, types/ must not reach up ---
    {
      name: "git-no-upper-layers",
      comment: "git/ must not import managers/ or view/",
      severity: "error",
      from: { path: "^src/git/" },
      to: { path: "^src/(managers|view)/" },
    },
    {
      name: "utils-no-upper-layers",
      comment: "utils/ must not import managers/ or view/",
      severity: "error",
      from: { path: "^src/utils/" },
      to: { path: "^src/(managers|view)/" },
    },
    {
      name: "services-no-upper-layers",
      comment: "services/ must not import managers/ or view/",
      severity: "error",
      from: { path: "^src/services/" },
      to: { path: "^src/(managers|view)/" },
    },
    {
      name: "types-no-imports",
      comment: "types/ must not import other layers",
      severity: "error",
      from: { path: "^src/types/" },
      to: { path: "^src/(git|managers|services|utils|view)/" },
    },

    // --- view/: pure presentation logic (shared with web) ---
    {
      name: "view-no-managers",
      comment:
        "view/ is pure presentation logic (shared with browser clients) — it may import git/, utils/, and types/, but never managers/",
      severity: "error",
      from: { path: "^src/view/" },
      to: { path: "^src/managers/" },
    },
    {
      name: "view-no-git-libs",
      comment:
        "view/ must stay browser-safe — no simple-git or chokidar (type-only imports of git/ modules are fine)",
      severity: "error",
      from: { path: "^src/view/" },
      to: { path: "node_modules/(simple-git|chokidar)/" },
    },
    {
      name: "view-no-node-runtime",
      comment:
        "view/ must stay browser-safe: it may import git/ and utils/ TYPES only (erased at build). A RUNTIME import of git/ or utils/ drags in node-only code (git/status pulls simple-git + node:child_process; utils/xdg pulls node:os). Dep-cruiser tracks runtime edges only by default, so type-only imports never trip this; a real runtime import does. This is the guard the layer exists for — it catches dropping `type` from an import, which build+deps+tests otherwise miss until the browser bundle breaks. Test files are exempt: they never enter a browser bundle (splitDiffByFile.test.ts parses fixtures with git/diffParse).",
      severity: "error",
      from: { path: "^src/view/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/(git|utils)/", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "managers-no-view",
      comment:
        "managers/ must not import view/ — presentation logic is client-side only. Single exception: splitDiffByFile, a pure per-file diff splitter that lives in view/ so web clients import the same copy; the JournalManager splits each observation's HEAD diff with it.",
      severity: "error",
      from: { path: "^src/managers/" },
      to: { path: "^src/view/", pathNot: "^src/view/splitDiffByFile\\.ts$" },
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
