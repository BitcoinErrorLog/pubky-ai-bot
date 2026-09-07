import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { pinSuiteDatabaseEnv } from "./tests/helpers/suite-database.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const suiteDatabaseUrl = pinSuiteDatabaseEnv();

export default defineConfig({
  resolve: {
    preserveSymlinks: true,
    alias: {
      "@pubky/bot-kit": path.join(root, "packages/bot-kit/src/index.ts"),
      "@pubky/pubchi-schemas": path.join(root, "packages/pubchi-schemas/src/index.ts"),
      "@pubky/pubchi": path.join(root, "packages/pubchi/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    exclude: ["**/._*", "node_modules/**", "src/bot-kit/**", "src/pubchi-schemas/**", "packages/pubchi/**"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    globalSetup: [path.join(root, "tests/global-setup.ts")],
    setupFiles: [path.join(root, "tests/setup-suite-database.ts")],
    env: {
      DATABASE_URL: suiteDatabaseUrl,
      ...(process.env.JEB_EVAL_DATABASE_URL
        ? { JEB_EVAL_DATABASE_URL: process.env.JEB_EVAL_DATABASE_URL }
        : {}),
    },
  },
});
