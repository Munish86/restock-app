// Tests run without the React Router plugin: they cover server code and the shared form logic.
// The flow tests start a real Postgres (PGlite) and a simulated Shopify store, so they get more time.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
