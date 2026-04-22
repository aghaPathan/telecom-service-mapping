import { defineConfig } from "vitest/config";
import path from "node:path";

// Shared resolver — both projects in vitest.workspace.ts extend this config
// via the string form, so the alias here applies to all projects.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
