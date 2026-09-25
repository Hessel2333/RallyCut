import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  use: { baseURL: "http://127.0.0.1:1421", viewport: { width: 1280, height: 800 } },
  webServer: { command: "npm run dev -- --port 1421", url: "http://127.0.0.1:1421", reuseExistingServer: !process.env.CI },
});
