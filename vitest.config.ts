import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@pubky/bot-kit": path.join(root, "packages/bot-kit/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    exclude: ["**/._*", "node_modules/**"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
