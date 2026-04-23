import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 10_000,
    hookTimeout: 60_000,
    include: ["tests/**/*.test.ts"],
    // Integration tests self-skip when SYNTHI_MCP_E2E is unset.
  },
});
