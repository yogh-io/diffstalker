/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // --- Bottom layer: git/, utils/, services/ must not reach up ---
    {
      name: "git-no-upper-layers",
      comment: "git/ must not import core/, state/, ui/, or ipc/",
      severity: "error",
      from: { path: "^src/git/" },
      to: { path: "^src/(core|state|ui|ipc)/" },
    },
    {
      name: "utils-no-upper-layers",
      comment: "utils/ must not import core/, state/, ui/, or ipc/",
      severity: "error",
      from: { path: "^src/utils/" },
      to: { path: "^src/(core|state|ui|ipc)/" },
    },
    {
      name: "services-no-upper-layers",
      comment: "services/ must not import core/, state/, ui/, or ipc/",
      severity: "error",
      from: { path: "^src/services/" },
      to: { path: "^src/(core|state|ui|ipc)/" },
    },

    // --- Middle layer: core/ and state/ must not reach into each other or up ---
    {
      name: "core-no-state-or-ui",
      comment: "core/ must not import state/ or ui/",
      severity: "error",
      from: { path: "^src/core/" },
      to: { path: "^src/(state|ui)/" },
    },
    {
      name: "state-no-core-or-ui",
      comment: "state/ must not import core/ or ui/",
      severity: "error",
      from: { path: "^src/state/" },
      to: { path: "^src/(core|ui)/" },
    },

    // --- UI layer must not import top-level orchestrators ---
    {
      name: "ui-no-top-level",
      comment: "ui/ must not import App, index, KeyBindings, MouseHandlers, or FollowMode",
      severity: "error",
      from: { path: "^src/ui/" },
      to: {
        path: "^src/(App|index|KeyBindings|MouseHandlers|FollowMode)\\.ts$",
      },
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
