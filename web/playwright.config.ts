import { defineConfig, devices } from "@playwright/test"
import { testSettings } from "./e2e/settings"

const storageState = "e2e/.auth/state.json"

// Desktop Chrome crashes between tests on this Mac, so use Playwright's
// headless shell. SERAPH_CHROME overrides the path.
const executablePath =
  process.env.SERAPH_CHROME ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`

// Builds the page against the tests' local Supabase (never the one in
// ~/.seraph) and serves it on 127.0.0.1:4173. `npm test` starts that Supabase
// and a controller of its own, then runs the fast UI suite; `npm run test:real`
// drives a real Claude session end to end the same way.
const supabase = testSettings()
const pageUrl = "http://127.0.0.1:4173"

export default defineConfig({
  webServer: {
    command: "npx vite build --logLevel error && npx vite preview --host 127.0.0.1 --port 4173 --strictPort",
    url: pageUrl,
    // Always a fresh build, so the tests never run against an old page.
    reuseExistingServer: false,
    timeout: 120_000,
    env: { VITE_SUPABASE_URL: supabase.url, VITE_SUPABASE_KEY: supabase.key },
  },
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.SERAPH_PAGE_URL ?? pageUrl,
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
