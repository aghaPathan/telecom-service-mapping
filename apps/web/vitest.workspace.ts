import { defineWorkspace } from "vitest/config";
import path from "node:path";

const alias = {
  "@": path.resolve(__dirname, "./"),
};

// tsconfig.json sets `jsx: preserve` for Next.js; vitest uses esbuild which
// needs an explicit jsx mode. `automatic` emits react/jsx-runtime imports so
// tests don't need React in scope.
const esbuild = { jsx: "automatic" as const };

export default defineWorkspace([
  {
    resolve: { alias },
    esbuild,
    test: {
      name: "unit",
      environment: "node",
      include: ["test/**/*.test.{ts,tsx}"],
      exclude: ["test/**/*.int.test.{ts,tsx}", "node_modules/**"],
      testTimeout: 10_000,
    },
  },
  {
    resolve: { alias },
    esbuild,
    test: {
      name: "integration",
      environment: "node",
      include: ["test/**/*.int.test.{ts,tsx}"],
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  },
]);
