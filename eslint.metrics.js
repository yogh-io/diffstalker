// eslint.metrics.js — single source for the metrics lint pass.
//
// Loaded by scripts/collect-metrics.ts for each package (with cwd set to the
// package dir). It layers low complexity/size thresholds on top of that
// package's own eslint.config.js so every function shows up in the metrics
// output. Kept here at the root so the four packages don't each carry an
// identical copy.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

// eslint loads this config from the package being linted (cwd = package dir),
// so resolve that package's base config relative to the cwd.
const baseUrl = pathToFileURL(join(process.cwd(), 'eslint.config.js')).href;
const baseConfig = (await import(baseUrl)).default;

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
