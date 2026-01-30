import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  eslintConfigPrettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Covered by @typescript-eslint/no-unused-vars
      'sonarjs/unused-import': 'off',
      'sonarjs/no-unused-vars': 'off',
      // This is a git CLI tool — executing OS commands is core functionality
      'sonarjs/os-command': 'off',
      'sonarjs/no-os-command-from-path': 'off',
      // We intentionally process ANSI escape sequences
      'no-control-regex': 'off',
      'sonarjs/no-control-regex': 'off',
      // Tracked via metrics, not a lint gate
      'sonarjs/cognitive-complexity': 'warn',
      'sonarjs/slow-regex': 'warn',
      'sonarjs/no-ignored-exceptions': 'warn',
      // Standard loop idiom (args[++i]) is clear; rule is too strict
      'sonarjs/updated-loop-counter': 'off',
      'sonarjs/no-dead-store': 'warn',
      'sonarjs/no-all-duplicated-branches': 'warn',
      'sonarjs/no-nested-conditional': 'warn',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'scripts/'],
  }
);
