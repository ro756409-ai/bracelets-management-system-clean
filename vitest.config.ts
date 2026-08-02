import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    setupFiles: [path.resolve(templateRoot, "vitest.setup.ts")],
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "server/**/*.spec.ts",
      "shared/**/*.test.ts",
      "shared/**/*.spec.ts",
      "scripts/**/*.test.ts",
      "scripts/**/*.spec.ts",
      // Pure-logic tests only (filter/pagination/etc reducers) — no DOM, so `environment:
      // node` above still applies. Component rendering tests would need jsdom + RTL, which
      // this project does not currently depend on.
      "client/src/**/*.test.ts",
      "client/src/**/*.spec.ts",
    ],
  },
});
