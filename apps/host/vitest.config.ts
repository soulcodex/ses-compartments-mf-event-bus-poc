import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
  },
  resolve: {
    alias: {
      "@poc/shared": new URL("../../packages/shared/src/index.ts", import.meta.url).pathname,
    },
  },
});