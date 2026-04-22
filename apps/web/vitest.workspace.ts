import { defineWorkspace } from "vitest/config";
import path from "node:path";

const alias = {
  "@": path.resolve(__dirname, "./"),
};

export default defineWorkspace([
  {
    resolve: { alias },
    test: {
      name: "unit",
      environment: "node",
      include: ["test/**/*.test.ts"],
      exclude: ["test/**/*.int.test.ts", "node_modules/**"],
      testTimeout: 10_000,
    },
  },
  {
    resolve: { alias },
    test: {
      name: "integration",
      environment: "node",
      include: ["test/**/*.int.test.ts"],
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  },
]);
