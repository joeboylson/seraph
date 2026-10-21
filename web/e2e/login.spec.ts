import { expect, test } from "@playwright/test"
import { createAccount, deleteAccount, requestCode, signInCode } from "./helpers"

// These start signed out.
test.use({ storageState: { cookies: [], origins: [] } })

test("an address without an account can't get a code", async ({ page }) => {
  await page.goto("/")
  await page.getByTestId("login-email").fill("nobody@test.invalid")
  await page.getByRole("button", { name: "Send code" }).click()
  await expect(page.getByRole("alert")).toHaveText("Sign-in failed.")
  await expect(page.getByTestId("login-code")).toBeHidden()
})

test("a wrong code is refused, the right one signs in, and sign out goes back", async ({ page }) => {
  const email = `login-${Date.now()}@test.invalid`
  await createAccount(email)
  try {
    await page.goto("/")
    await requestCode(page, email)
    await page.getByTestId("login-code").fill("000000")
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page.getByRole("alert")).toContainText("wrong or has expired")

    await page.getByTestId("login-code").fill(await signInCode(email))
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page.getByRole("button", { name: "Sessions" })).toBeVisible()

    // Still signed in after a reload.
    await page.reload()
    await expect(page.getByRole("button", { name: "Sessions" })).toBeVisible()

    await page.getByRole("button", { name: "Sign out" }).click()
    await expect(page.getByTestId("login-email")).toHaveValue(email)
  } finally {
    await deleteAccount(email)
  }
})

test("an account that isn't a member is turned away", async ({ page }) => {
  const email = `outsider-${Date.now()}@test.invalid`
  await createAccount(email, false)
  try {
    await page.goto("/")
    await requestCode(page, email)
    await page.getByTestId("login-code").fill(await signInCode(email))
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page.getByRole("heading")).toHaveText("Sign-in failed.")
    await expect(page.getByText(email)).toHaveCount(0)
    await expect(page.getByText("seraph user add")).toHaveCount(0)
    await page.getByRole("button", { name: "Sign out" }).click()
    await expect(page.getByTestId("login-email")).toBeVisible()
  } finally {
    await deleteAccount(email)
  }
})
