import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import sonarjs from 'eslint-plugin-sonarjs';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  // flat/recommended wires vue-eslint-parser for .vue files
  ...pluginVue.configs['flat/recommended'],
  eslintConfigPrettier,
  {
    // This package runs in the browser (dep-cruiser bans node:* imports)
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // <script setup lang="ts"> blocks parse through typescript-eslint
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Covered by @typescript-eslint/no-unused-vars
      'sonarjs/unused-import': 'off',
      'sonarjs/no-unused-vars': 'off',
      // Tracked via metrics, not a lint gate
      'sonarjs/cognitive-complexity': 'warn',
      // sonarjs 4 (with eslint 10) added these as errors. They are opinionated
      // (test-assertion / parameterized-test style) and, for super-linear-regex,
      // conservative on our TRUSTED, bounded git output (not attacker input) —
      // disabled to match this repo's existing sonarjs stance (slow-regex,
      // no-control-regex, etc. are off; cognitive-complexity is a warning).
      'sonarjs/prefer-specific-assertions': 'off',
      'sonarjs/parameterized-tests': 'off',
      'sonarjs/super-linear-regex': 'off',
      'sonarjs/no-floating-point-equality': 'off',
      // These catch real bugs — enforce as errors, not tracked warnings
      'sonarjs/no-dead-store': 'error',
      'sonarjs/no-all-duplicated-branches': 'error',
      'sonarjs/no-nested-conditional': 'warn',
    },
  },
  {
    ignores: ['dist/', 'node_modules/'],
  }
);
