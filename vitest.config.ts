import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/._*", "node_modules/**"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
