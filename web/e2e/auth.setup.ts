import { expect, test as setup } from "@playwright/test"
import { createAccount, requestCode, signInCode, TEST_EMAIL } from "./helpers"

const STATE_PATH = "e2e/.auth/state.json"

// Sign in once through the real login screen; the other tests reuse the session.
setup("sign in", async ({ page }) => {
  await createAccount(TEST_EMAIL)
  await page.goto("/")
  await requestCode(page, TEST_EMAIL)
  await page.getByTestId("login-code").fill(await signInCode(TEST_EMAIL))
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("button", { name: "Sessions" })).toBeVisible()
  await page.context().storageState({ path: STATE_PATH })
})
