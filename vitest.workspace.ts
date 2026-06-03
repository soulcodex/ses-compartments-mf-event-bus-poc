import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  // Root legacy tests (existing flat structure)
  {
    extends: "./vitest.config.ts",
    test: {
      name: "root",
      include: ["tests/**/*.test.ts"],
    },
  },
  // Host app tests
  {
    extends: "./apps/host/vitest.config.ts",
    test: {
      name: "host",
      root: "./apps/host",
      include: ["tests/**/*.test.ts"],
    },
  },
]);