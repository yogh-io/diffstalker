// eslint.metrics.js
// Used by the metrics script to gather complexity data.
// Warns at low thresholds so all functions appear in the output.
import baseConfig from './eslint.config.js';

export default [
  ...baseConfig,
  {
    rules: {
      complexity: ['warn', { max: 1 }],
      'sonarjs/cognitive-complexity': ['warn', 1],
      'max-lines-per-function': ['warn', { max: 1 }],
    },
  },
];
