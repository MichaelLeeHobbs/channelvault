// Flat ESLint config (ESLint v9+). Lints the TypeScript sources and tests with
// the typescript-eslint recommended rule set (non-type-checked, for speed).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Build output, dependencies, and the scratch directories .gitignore excludes.
    ignores: ['dist/', 'node_modules/', 'coverage/', 'out/', '*.local.json', 'scratch/', 'tmp/', 'tmp-out/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // Unused vars are errors, but allow intentionally-ignored ones prefixed
      // with `_` (e.g. the `_name` params in the fast-xml-parser processors).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
