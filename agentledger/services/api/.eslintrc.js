module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js', 'dist', 'node_modules', 'jest.config.js'],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    // review-nodejs-code standard, ESLint-autofixable: use let/const, and
    // require braces on every control statement.
    'no-var': 'error',
    curly: ['error', 'all'],
    // Cyclomatic-complexity ratchet. review-nodejs-code targets <=5; the current
    // API ceiling is 85, so this only blocks regression past today's worst and is
    // meant to be lowered as god services are decomposed (135 functions still
    // exceed 8 — tracked follow-up, not a blocker).
    complexity: ['warn', 85],
  },
};
