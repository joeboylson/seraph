import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { db } from "./helpers"

// Drives a real Claude session (Haiku) through the web page only, start to
// finish. Needs `seraph daemon` running. Costs a few cents.

const SANDBOX = path.resolve(import.meta.dirname, "../../sandbox")

async function sessionStatus(id: string) {
  const { data } = await db.from("sessions").select("status").eq("id", id).single()
  return data?.status as string | undefined
}

/**
 * Answer every menu Claude shows with "Yes" until `done` holds, the way a
 * person approving from their phone would. Picks the option that starts with
 * "Yes", not the first: the folder-trust question lists "No, exit" first.
 */
async function approveUntil(page: Page, sessionId: string, done: () => Promise<boolean>, timeoutMs = 4 * 60_000) {
  const deadline = Date.now() + timeoutMs
  let approvals = 0
  while (Date.now() < deadline) {
    const card = page.getByTestId("prompt-card")
    const choices = card.getByTestId("prompt-choice")
    const yes = choices.filter({ hasText: /^\s*\d*\s*Yes/ }).first()
    const choice = (await yes.count()) ? yes : choices.first()
    if ((await card.isVisible()) && (await choice.isEnabled())) {
      await choice.click()
      approvals++
      continue
    }
    if ((await sessionStatus(sessionId)) === "idle" && (await done())) return approvals
    await page.waitForTimeout(1000)
  }
  throw new Error("timed out waiting for Claude")
}

test("build a small app from the web page @real", async ({ page }) => {
  fs.mkdirSync(SANDBOX, { recursive: true })
  const folder = `counter-${Date.now()}`
  const appDir = path.join(SANDBOX, folder)
  const indexFile = path.join(appDir, "index.html")
  const sessionId = () => page.url().match(/#\/s\/([\w-]+)/)?.[1] ?? ""

  // 1. Start a session in a new folder, with a first message.
  await page.goto("/")
  await page.getByTestId("new-session").first().click()
  await expect(page.getByTestId("folders").getByTestId("folder").first()).toBeVisible()
  const cwd = page.getByTestId("cwd")
  await cwd.fill(SANDBOX)
  await cwd.press("Enter")
  await expect(cwd).toHaveValue(SANDBOX)
  await page.getByTestId("new-folder").fill(folder)
  await page.getByLabel("Model").click()
  await page.getByRole("option", { name: "Haiku" }).click()
  // Ask before edits, so the permission flow gets exercised.
  await page.getByLabel("Permissions").click()
  await page.getByRole("option", { name: "Ask before edits" }).click()
  await page.getByTestId("session-name").fill(`counter ${folder}`)
  await page.getByTestId("first-prompt").fill(
    "Build a tiny counter web app in this folder as a single index.html with inline CSS and JS. " +
      'Show the count in an element with id="count" (starting at 0), and add three buttons with ids ' +
      '"inc" (+1), "dec" (-1) and "reset". Write the file with the Write tool. Don\'t run anything.',
  )
  // The page may already show an older session, so wait for the switch.
  const before = sessionId()
  await page.getByTestId("start-session").click()
  await expect.poll(sessionId, { timeout: 60_000 }).not.toBe(before)
  const id = sessionId()
  await expect(page.getByTestId("session-title")).toHaveText(`counter ${folder}`)

  // 2. Claude asks to write the file; approve from the page.
  const approvals = await approveUntil(page, id, async () => fs.existsSync(indexFile))
  expect(approvals).toBeGreaterThan(0)
  await expect(page.getByTestId("tool-card").filter({ hasText: "Write" }).first()).toBeVisible({ timeout: 60_000 })

  // 3. A follow-up through the message box.
  await page.getByTestId("composer").fill('Add a button with id "double" that doubles the count. Edit the existing file.')
  await page.getByTestId("send").click()
  await approveUntil(page, id, async () => fs.readFileSync(indexFile, "utf8").includes('id="double"'))

  // 4. A slash command. /cost opens a panel that waits for Esc; read it on
  // the page and close it from there.
  await page.getByTestId("composer").fill("/cost")
  await page.getByTestId("composer").press("Enter")
  const panel = page.getByTestId("prompt-card")
  await expect(panel.getByTestId("prompt-body")).toBeVisible({ timeout: 60_000 })
  await expect(panel.getByTestId("prompt-escape")).toBeEnabled()
  await panel.getByTestId("prompt-escape").click()
  await expect(panel).toHaveCount(0)
  // Claude records it as /usage, which /cost is now an alias of.
  await expect(page.getByTestId("chat").getByText(/^\/(cost|usage)$/).first()).toBeVisible({ timeout: 60_000 })

  // 5. Stop a long task partway.
  await page.getByTestId("composer").fill('Run this exact bash command and nothing else: python3 -c "import time; time.sleep(120)"')
  await page.getByTestId("send").click()
  await expect.poll(async () => {
    const choice = page.getByTestId("prompt-card").getByTestId("prompt-choice").first()
    if ((await choice.isVisible()) && (await choice.isEnabled())) await choice.click()
    return sessionStatus(id)
  }, { timeout: 120_000, intervals: [1000] }).toBe("working")
  await page.waitForTimeout(3000)
  await page.getByTestId("interrupt").click()
  await expect.poll(() => sessionStatus(id), { timeout: 60_000 }).not.toBe("working")

  // 6. End the session, then resume it from the page.
  await page.getByTestId("power").click()
  await page.getByTestId("end-session").click()
  await page.getByTestId("confirm").click()
  await expect.poll(() => sessionStatus(id), { timeout: 60_000 }).toBe("ended")
  // A session started from the page carries on in place: same session, same link.
  await page.getByTestId("resume").click()
  await expect.poll(() => sessionStatus(id), { timeout: 90_000 }).toBe("idle")
  expect(sessionId()).toBe(id)
  const resumed = id
  await page.getByTestId("composer").fill("In one word, what is the name of the HTML file you made?")
  await page.getByTestId("send").click()
  await expect(page.getByTestId("chat").getByText(/index\.html/i).last()).toBeVisible({ timeout: 120_000 })

  // Send an image from the page.
  const painter = await page.context().newPage()
  await painter.setContent('<div style="width:233px;height:233px;background:#e00"></div>')
  const red = await painter.locator("div").screenshot()
  await painter.close()
  await page.getByTestId("image-input").setInputFiles({ name: "swatch.png", mimeType: "image/png", buffer: red })
  await page.getByTestId("composer").fill("What colour is the attached image? Answer with just the colour name in capitals.")
  await page.getByTestId("send").click()
  await approveUntil(page, resumed, async () => {
    const { data } = await db.from("messages").select("data").eq("session_id", resumed).eq("type", "assistant")
    return JSON.stringify(data).includes("RED")
  })
  await page.getByTestId("power").click()
  await page.getByTestId("end-session").click()
  await page.getByTestId("confirm").click()
  await expect.poll(() => sessionStatus(resumed), { timeout: 60_000 }).toBe("ended")

  // 7. The app Claude built works.
  const app = await page.context().newPage()
  await app.goto(`file://${indexFile}`)
  await expect(app.locator("#count")).toHaveText("0")
  await app.locator("#inc").click()
  await app.locator("#inc").click()
  await expect(app.locator("#count")).toHaveText("2")
  await app.locator("#double").click()
  await expect(app.locator("#count")).toHaveText("4")
  await app.locator("#dec").click()
  await expect(app.locator("#count")).toHaveText("3")
  await app.locator("#reset").click()
  await expect(app.locator("#count")).toHaveText("0")
})
