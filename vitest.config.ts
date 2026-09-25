import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Framework test apps (stage 2) bring their own dependencies and runners.
    exclude: [...configDefaults.exclude, "test/apps/**"],
    environment: "node"
  }
});
