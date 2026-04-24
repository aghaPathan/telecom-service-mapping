import { defineWorkspace } from "vitest/config";
import path from "node:path";

const alias = {
  "@": path.resolve(__dirname, "./"),
};

export default defineWorkspace([
  {
    resolve: { alias },
    // tsconfig.json sets `jsx: preserve` for Next.js; vitest uses esbuild which
    // needs an explicit jsx mode. `automatic` emits react/jsx-runtime imports so
    // tests don't need React in scope. Scoped to unit — integration has no JSX.
    esbuild: { jsx: "automatic" as const },
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
    // `page.tsx` integration tests render server components via
    // renderToStaticMarkup, so the integration project also needs the
    // automatic-jsx transform (page modules carry JSX).
    esbuild: { jsx: "automatic" as const },
    test: {
      name: "integration",
      environment: "node",
      include: ["test/**/*.int.test.{ts,tsx}"],
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  },
]);
