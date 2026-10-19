import { test as teardown } from "@playwright/test"
import { deleteAccount, TEST_EMAIL } from "./helpers"

teardown("delete the test account", async () => {
  await deleteAccount(TEST_EMAIL)
})
