import { defineConfig, devices } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT || "5173";
const publicOrigin = process.env.PLAYWRIGHT_BASE_URL
  || process.env.PLAYWRIGHT_PUBLIC_ORIGIN
  || `http://127.0.0.1:${port}`;

const dbPath = process.env.PLAYWRIGHT_DB_PATH || `/tmp/ai-trading-bot-playwright-${Date.now()}.sqlite`;

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 45_000,
  use: {
    baseURL: publicOrigin,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `TRADING_DB_PATH=${dbPath} ADMIN_WALLET_ADDRESS=0x1111111111111111111111111111111111111111 npm run dev:full -- --host 0.0.0.0 --port ${port}`,
    url: publicOrigin,
    reuseExistingServer: false,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});