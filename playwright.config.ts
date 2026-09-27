import { defineConfig } from "@playwright/test";
const port = process.env.RALLYCUT_E2E_PORT || "1437";
export default defineConfig({
  testDir: "./tests",
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1280, height: 800 } },
  webServer: { command: `npm run dev -- --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
