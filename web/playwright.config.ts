import { defineConfig, devices } from "@playwright/test"
import { seraphSettings } from "./e2e/settings"

const storageState = "e2e/.auth/state.json"

// Desktop Chrome crashes between tests on this Mac, so use Playwright's
// headless shell. CSC_CHROME overrides the path.
const executablePath =
  process.env.CSC_CHROME ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`

// Runs against the page served by `csc daemon` (it serves web/dist).
// `npm test` runs the fast UI suite; `npm run test:real` drives a real
// Claude session end to end.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.CSC_WEB_URL ?? seraphSettings().webUrl,
    launchOptions: { executablePath },
    trace: "retain-on-failure",
  },
  // `setup` signs in through the login screen once and saves the session;
  // the other projects start from it.
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/, teardown: "teardown", use: { ...devices["Desktop Chrome"] } },
    { name: "teardown", testMatch: /auth\.teardown\.ts/ },
    { name: "desktop", use: { ...devices["Desktop Chrome"], storageState }, dependencies: ["setup"], grepInvert: /@real|@mobile/ },
    { name: "mobile", use: { ...devices["Pixel 7"], storageState }, dependencies: ["setup"], grep: /@mobile/ },
    { name: "real", use: { ...devices["Desktop Chrome"], storageState }, dependencies: ["setup"], grep: /@real/, timeout: 15 * 60_000, expect: { timeout: 60_000 } },
  ],
})
