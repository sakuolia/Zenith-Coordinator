import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: true,
  },
  resolve: {
    // Vitest で src/ 内の相対インポートを解決
    alias: {},
  },
});
