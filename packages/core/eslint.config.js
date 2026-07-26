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
      // sonarjs 4 (with eslint 10) added these as errors. They are opinionated
      // (test-assertion / parameterized-test style) and, for super-linear-regex,
      // conservative on our TRUSTED, bounded git output (not attacker input) —
      // disabled to match this repo's existing sonarjs stance (slow-regex,
      // no-control-regex, etc. are off; cognitive-complexity is a warning).
      'sonarjs/prefer-specific-assertions': 'off',
      'sonarjs/parameterized-tests': 'off',
      'sonarjs/super-linear-regex': 'off',
      'sonarjs/no-floating-point-equality': 'off',
      // Only simple utility patterns (blessed tag stripping, ANSI); no user input
      'sonarjs/slow-regex': 'off',
      // Intentional empty catches for graceful fallbacks (file reads, git ops)
      'sonarjs/no-ignored-exceptions': 'off',
      // Standard loop idiom (args[++i]) is clear; rule is too strict
      'sonarjs/updated-loop-counter': 'off',
      // These catch real bugs — enforce as errors, not tracked warnings
      'sonarjs/no-dead-store': 'error',
      'sonarjs/no-all-duplicated-branches': 'error',
      'sonarjs/no-nested-conditional': 'warn',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'scripts/'],
  }
);
