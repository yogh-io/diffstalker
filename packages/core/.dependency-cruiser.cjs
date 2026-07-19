/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // --- Bottom layer: git/, utils/, services/, types/ must not reach up ---
    {
      name: "git-no-upper-layers",
      comment: "git/ must not import managers/",
      severity: "error",
      from: { path: "^src/git/" },
      to: { path: "^src/managers/" },
    },
    {
      name: "utils-no-upper-layers",
      comment: "utils/ must not import managers/",
      severity: "error",
      from: { path: "^src/utils/" },
      to: { path: "^src/managers/" },
    },
    {
      name: "services-no-upper-layers",
      comment: "services/ must not import managers/",
      severity: "error",
      from: { path: "^src/services/" },
      to: { path: "^src/managers/" },
    },
    {
      name: "types-no-imports",
      comment: "types/ must not import other layers",
      severity: "error",
      from: { path: "^src/types/" },
      to: { path: "^src/(git|managers|services|utils)/" },
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
