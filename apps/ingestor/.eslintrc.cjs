/* Real lint for the ingestor — no longer a placeholder. See ADR 0002 /
 * slice 5 ops-hardening. Ships with @typescript-eslint/recommended and the
 * only opinionated tweak is `no-unused-vars` honoring the `_`-prefix
 * convention so explicit-discard patterns (e.g. `for (const _row of rows)`)
 * don't need inline disables. */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  env: { node: true, es2022: true },
  ignorePatterns: ["dist/", "node_modules/"],
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      },
    ],
    "@typescript-eslint/no-explicit-any": "warn",
  },
};
