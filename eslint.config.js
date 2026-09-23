import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'dist-firefox',
      'release',
      'web-ext-artifacts',
      'node_modules',
      '_site',
      '.local-backups',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The DNR structural cast in apply.ts is a deliberate boundary cast.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Node build scripts run outside the browser; declare the Node globals they use.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
  // The e2e driver is a Node script that also evaluates code inside the browser
  // page, so it legitimately references both sets of globals.
  {
    files: ['test/e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        WebSocket: 'readonly',
        // Referenced inside page.evaluate() callbacks, which run in the page.
        document: 'readonly',
        window: 'readonly',
        Event: 'readonly',
        chrome: 'readonly',
      },
    },
  },
  // Prettier must come last so it can turn off stylistic rules.
  prettier,
);
