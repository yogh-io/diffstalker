/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // --- Bottom layer: utils/ and types/ must not reach up ---
    {
      name: "utils-no-upper-layers",
      comment: "utils/ must not import state/, daemon/, or ui/",
      severity: "error",
      from: { path: "^src/utils/" },
      to: { path: "^src/(state|daemon|ui)/" },
    },
    {
      name: "types-no-upper-layers",
      comment: "types/ must not import state/, daemon/, ui/, or utils/",
      severity: "error",
      from: { path: "^src/types/" },
      to: { path: "^src/(state|daemon|ui|utils)/" },
    },

    // --- Middle layer: state/ and daemon/ must not import ui/ or each other ---
    {
      name: "state-no-ui-or-daemon",
      comment: "state/ must not import ui/ or daemon/",
      severity: "error",
      from: { path: "^src/state/" },
      to: { path: "^src/(ui|daemon)/" },
    },
    {
      name: "daemon-no-ui-or-state",
      comment: "daemon/ must not import ui/ or state/",
      severity: "error",
      from: { path: "^src/daemon/" },
      to: { path: "^src/(ui|state)/" },
    },

    // --- Only top-level orchestrators may import top-level orchestrators ---
    {
      name: "lower-layers-no-top-level",
      comment:
        "ui/, state/, daemon/, utils/, and types/ must not import App, index, KeyBindings, MouseHandlers, NavigationController, StagingOperations, ModalController, or FollowMode",
      severity: "error",
      from: { path: "^src/(ui|state|daemon|utils|types)/" },
      to: {
        path: "^src/(App|index|KeyBindings|MouseHandlers|NavigationController|StagingOperations|ModalController|FollowMode)\\.ts$",
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
