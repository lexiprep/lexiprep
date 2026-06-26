import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Component tests run in jsdom; setup registers jest-dom matchers and RTL auto-cleanup.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
});
