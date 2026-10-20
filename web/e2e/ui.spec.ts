import { expect, test } from "@playwright/test"
import { addMessages, db, expectCommand, fakeSession, removeSession, sendScreen } from "./helpers"

let session: { id: string; name: string }

test.beforeEach(async () => {
  session = await fakeSession()
})

test.afterEach(async () => {
  await removeSession(session.id)
})

test("shows the conversation, including tool calls and their results", async ({ page }) => {
  await addMessages(session.id, [
    { type: "user", message: { role: "user", content: "Make a counter app" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I'll create **index.html**." },
          { type: "tool_use", id: "tu_1", name: "Write", input: { file_path: "/tmp/seraph-test/project/index.html", content: "<button>+</button>" } },
        ],
      },
    },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "File created successfully" }] } },
    { type: "user", message: { role: "user", content: "<command-name>/compact</command-name><command-args></command-args>" } },
    { type: "system", subtype: "local_command", content: "<command-name>/usage</command-name><command-args></command-args>" },
    { type: "system", subtype: "local_command", content: "<local-command-stdout>Settings dialog dismissed</local-command-stdout>" },
  ])
  await page.goto(`/#/s/${session.id}`)
  await expect(page.getByTestId("session-title")).toHaveText(session.name)
  const chat = page.getByTestId("chat")
  await expect(chat.getByText("Make a counter app")).toBeVisible()
  await expect(chat.locator("strong", { hasText: "index.html" })).toBeVisible()
  await expect(chat.getByText("/compact")).toBeVisible()
  await expect(chat.getByText("/usage")).toBeVisible()
  await expect(chat.getByText("Settings dialog dismissed")).toBeVisible()

  // A file write shows its path inside the project and the lines it adds.
  const tool = page.getByTestId("tool-card")
  await expect(tool).toContainText("Write")
  await expect(tool).toContainText("index.html")
  await expect(tool).not.toContainText("/tmp/seraph-test/project")
  await expect(tool).toContainText("+1 −0")
  await expect(tool).toContainText("done")
  await tool.getByRole("button").click()
  await expect(tool.getByTestId("diff")).toContainText("<button>+</button>")
})

test("new messages arrive live", async ({ page }) => {
  await page.goto(`/#/s/${session.id}`)
  await expect(page.getByText("No messages yet")).toBeVisible()
  await addMessages(session.id, [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hello from the live feed" }] } }])
  await expect(page.getByText("Hello from the live feed")).toBeVisible()
})

test("sending a message queues it for the session", async ({ page }) => {
  await page.goto(`/#/s/${session.id}`)
  const text = `Build it ${Date.now()}\nwith two lines`
  await page.getByTestId("composer").fill(text)
  await page.getByTestId("composer").press("Enter")
  await expectCommand(session.id, "prompt", (p) => p.text === text)
  await expect(page.getByTestId("composer")).toHaveValue("")
  // It shows in the chat straight away, before the transcript has it.
  await expect(page.getByTestId("sent")).toContainText("with two lines")
})

test("slash commands are suggested and sent", async ({ page }) => {
  await page.goto(`/#/s/${session.id}`)
  await page.getByTestId("composer").fill("/co")
  const menu = page.getByRole("listbox", { name: "Commands" })
  await expect(menu).toContainText("/compact")
  await expect(menu).toContainText("/context")
  await menu.getByRole("option", { name: /\/compact/ }).click()
  await expectCommand(session.id, "prompt", (p) => p.text === "/compact")
})

test("status changes show live, and Stop interrupts", async ({ page }) => {
  await page.goto(`/#/s/${session.id}`)
  await expect(page.getByTestId("interrupt")).toHaveCount(0)
  await db.from("sessions").update({ status: "working" }).eq("id", session.id)
  await expect(page.locator("main [data-status=working]").first()).toBeVisible()
  await expect(page.getByTestId("working")).toBeVisible()
  await page.getByTestId("interrupt").click()
  await expectCommand(session.id, "interrupt")
})

test("a menu on Claude's screen becomes buttons", async ({ page }) => {
  await page.goto(`/#/s/${session.id}`)
  await expectCommand(session.id, "replay") // the page asked for the screen
  await db.from("events").insert({
    session_id: "claude-1",
    csc_session: session.id,
    hook_event: "PermissionRequest",
    payload: { tool_name: "Bash", tool_input: { command: "npm install" } },
  })
  await sendScreen(
    session.id,
    [
      "⏺ Bash(npm install)",
      "",
      " Bash command",
      "   npm install",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and don't ask again for npm install commands",
      "   3. No",
      "",
      " Esc to cancel · Tab to amend",
    ].join("\n"),
  )
  const card = page.getByTestId("prompt-card")
  await expect(card).toContainText("Do you want to proceed?")
  await expect(card).toContainText("npm install")
  await expect(card.getByTestId("prompt-choice")).toHaveCount(3)
  // Buttons wait for Claude's menu to settle, then show the tap was sent.
  const no = card.getByRole("button", { name: /3\s*No/ })
  await expect(no).toBeDisabled()
  await expect(no).toBeEnabled()
  await no.click()
  await expectCommand(session.id, "keys", (p) => JSON.stringify(p.keys) === '["3"]')
  // With no fresh output, the page can't tell whether the tap landed, so it
  // doesn't offer a retry (a late second tap could type into Claude's input).
  await page.waitForTimeout(4500)
  await expect(card.getByTestId("prompt-state")).toHaveAttribute("data-state", "sent")
  await expect(no).toBeDisabled()
  // Fresh output still showing the menu means the tap didn't land: retry.
  await sendScreen(session.id, "\x1b[1;1H")
  await expect(card.getByTestId("prompt-state")).toHaveAttribute("data-state", "retry", { timeout: 6000 })
  await expect(no).toBeEnabled()

  // When the menu goes away, so does the card.
  await sendScreen(session.id, "\x1b[2J\x1b[H⏺ Done.\n")
  await expect(card).toHaveCount(0)
})

test("a numbered list in Claude's reply is not mistaken for a menu", async ({ page }) => {
  await page.goto(`/#/s/${session.id}`)
  await expectCommand(session.id, "replay")
  await sendScreen(session.id, "⏺ Steps:\n  1. Install\n  3. Run\n\n❯ \n")
  await expect(page.getByTestId("terminal-tab")).toBeEnabled()
  await page.waitForTimeout(1000)
  await expect(page.getByTestId("prompt-card")).toHaveCount(0)
})

test("the terminal mirrors the screen and sends typed keys", async ({ page }) => {
  await page.goto(`/#/s/${session.id}`)
  await page.getByTestId("terminal-tab").click()
  await expectCommand(session.id, "replay")
  await sendScreen(session.id, "hello from the terminal\n❯ ")
  await expect(page.getByTestId("terminal")).toContainText("hello from the terminal")
  await page.getByTestId("terminal").click()
  await page.keyboard.type("ls")
  await expectCommand(session.id, "keys", (p) => p.data === "ls")
  await page.getByRole("button", { name: "⇧Tab" }).click()
  await expectCommand(session.id, "keys", (p) => JSON.stringify(p.keys) === '["ShiftTab"]')
})

test("an ended session can't be messaged and offers Resume", async ({ page }) => {
  await db.from("sessions").update({ status: "ended", claude_session_id: "abc-123" }).eq("id", session.id)
  await page.goto(`/#/s/${session.id}`)
  await expect(page.getByTestId("composer")).toBeDisabled()
  await expect(page.getByTestId("resume")).toBeVisible()
  await expect(page.getByTestId("terminal-tab")).toBeDisabled()
})

test("the new-session dialog browses folders on the Mac", async ({ page }) => {
  await page.goto(`/#/s/${session.id}`)
  await expect(page.getByTestId("controller-status")).toHaveAttribute("data-online", "true")
  await page.getByTestId("new-session").click()
  const path = page.getByTestId("cwd")
  await path.fill("/tmp")
  await path.press("Enter")
  await expect(path).toHaveValue(/\/(private\/)?tmp$/)
  await expect(page.getByTestId("folders")).toBeVisible()
})

test("phone layout fits the screen and the session list slides in @mobile", async ({ page }) => {
  await page.goto(`/#/s/${session.id}`)
  await expect(page.getByTestId("session-title")).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(overflow).toBe(false)
  await page.getByRole("button", { name: "Sessions" }).click()
  await expect(page.getByRole("dialog").getByTestId("new-session")).toBeVisible()
})

test("a linked session is read-only and says how to take control", async ({ page }) => {
  await db.from("sessions").update({ mode: "linked", status: "working", claude_session_id: "c-42" }).eq("id", session.id)
  await page.goto(`/#/s/${session.id}`)
  await expect(page.getByTestId("linked-note")).toContainText("seraph resume c-42")
  await expect(page.getByTestId("composer")).toHaveCount(0)
  await expect(page.getByTestId("terminal-tab")).toBeDisabled()
})

test("a missing chunk of screen output triggers a fresh copy", async ({ page }) => {
  await page.goto(`/#/s/${session.id}`)
  await expectCommand(session.id, "replay")
  await page.waitForTimeout(3500) // replays are spaced at least 3s apart
  await sendScreen(session.id, "first\n", 100)
  await sendScreen(session.id, "fourth\n", 103) // 101 and 102 never arrived
  await expect
    .poll(async () => (await db.from("commands").select("id").eq("session_id", session.id).eq("kind", "replay")).data?.length)
    .toBe(2)
})

test("a panel waiting for Esc (like /cost) can be read and closed", async ({ page }) => {
  await page.goto(`/#/s/${session.id}`)
  await expectCommand(session.id, "replay")
  await sendScreen(
    session.id,
    ["❯ /cost", "", "─".repeat(60), "  Usage", "  Session cost: $0.02", "  Total tokens: 12,345", "", "  Esc to cancel"].join("\n"),
  )
  const card = page.getByTestId("prompt-card")
  await expect(card).toContainText("Claude is showing")
  await expect(card.getByTestId("prompt-body")).toContainText("Session cost: $0.02")
  await expect(card.getByTestId("prompt-choice")).toHaveCount(0)
  const close = card.getByTestId("prompt-escape")
  await expect(close).toBeEnabled()
  await close.click()
  await expectCommand(session.id, "keys", (p) => JSON.stringify(p.keys) === '["Escape"]')
})

test("images can be attached to a message", async ({ page }) => {
  await page.goto(`/#/s/${session.id}`)
  // A 1x1 red PNG.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64")
  await page.getByTestId("image-input").setInputFiles({ name: "red.png", mimeType: "image/png", buffer: png })
  await expect(page.getByRole("img", { name: "red.png" })).toBeVisible()
  await page.getByTestId("composer").fill("What colour is this?")
  await page.getByTestId("send").click()
  const cmd = await expectCommand(session.id, "prompt", (p) => p.text === "What colour is this?")
  const images = cmd.payload.images as { name: string; type: string; data: string }[]
  expect(images).toHaveLength(1)
  expect(images[0]).toMatchObject({ name: "red.png", type: "image/png" })
  expect(Buffer.from(images[0].data, "base64").equals(png)).toBe(true)
  await expect(page.getByTestId("sent")).toContainText("1 image attached")
})

test("the Mode button shows the mode from Claude's status line and switches it", async ({ page }) => {
  await page.goto(`/#/s/${session.id}`)
  await expectCommand(session.id, "replay")
  const mode = page.getByTestId("mode")
  await sendScreen(session.id, "❯ \n  ⏸ manual mode on · ? for shortcuts\n")
  await expect(mode).toHaveText("Ask before edits")
  await mode.click()
  await expectCommand(session.id, "keys", (p) => JSON.stringify(p.keys) === '["ShiftTab"]')
  await sendScreen(session.id, "\x1b[2J\x1b[H❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)\n")
  await expect(mode).toHaveText("Accept edits")
  await sendScreen(session.id, "\x1b[2J\x1b[H❯ \n  ⏸ plan mode on (shift+tab to cycle)\n")
  await expect(mode).toHaveText("Plan mode")
})

test("Claude's todo list shows above the message box, and the header shows context used", async ({ page }) => {
  const todos = [
    { content: "Find settings page", status: "completed", activeForm: "Finding settings page" },
    { content: "Add dark mode toggle", status: "in_progress", activeForm: "Adding dark mode toggle" },
    { content: "Write a test", status: "pending", activeForm: "Writing a test" },
  ]
  await addMessages(session.id, [
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "td1", name: "TodoWrite", input: { todos } }] } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "ed1", name: "Edit", input: { file_path: "/tmp/seraph-test/project/src/app.ts", old_string: "a\nb", new_string: "a\nc\nd" } },
        ],
        usage: { input_tokens: 10, cache_read_input_tokens: 45_000, cache_creation_input_tokens: 2_000, output_tokens: 50 },
      },
    },
  ])
  await page.goto(`/#/s/${session.id}`)
  await expect(page.getByTestId("session-meta")).toContainText("47k context")

  const plan = page.getByTestId("plan")
  await expect(plan).toContainText("Adding dark mode toggle")
  await expect(plan).toContainText("1/3")
  await plan.getByRole("button").click()
  await expect(plan.getByTestId("todos")).toContainText("Write a test")

  const edit = page.locator('[data-tool="Edit"]')
  await expect(edit).toContainText("src/app.ts")
  await expect(edit).toContainText("+2 −1")
  await edit.getByRole("button").click()
  await expect(edit.getByTestId("diff")).toContainText("c")
})

test("a session can be renamed, and an ended one deleted with its conversation", async ({ page }) => {
  await addMessages(session.id, [{ type: "user", message: { role: "user", content: "hello" } }])
  await page.goto(`/#/s/${session.id}`)
  await page.getByTestId("rename").click()
  await page.getByTestId("rename-input").fill("Renamed from the phone")
  await page.getByTestId("rename-save").click()
  await expect(page.getByTestId("session-title")).toHaveText("Renamed from the phone")

  await db.from("sessions").update({ status: "ended", ended_at: new Date().toISOString() }).eq("id", session.id)
  await expect(page.getByTestId("delete-session")).toBeVisible()
  await page.getByTestId("delete-session").click()
  await page.getByTestId("confirm").click()
  await expect.poll(async () => (await db.from("messages").select("id").eq("session_id", session.id)).data?.length).toBe(0)
  await expect(page.getByText("Renamed from the phone")).toHaveCount(0)
})

test("the session list can be searched", async ({ page }) => {
  const others = await Promise.all(Array.from({ length: 9 }, (_, i) => fakeSession({ name: `filler ${i}`, status: "ended" })))
  try {
    await page.goto(`/#/s/${session.id}`)
    const list = page.getByRole("navigation", { name: "Sessions" })
    await list.getByTestId("session-search").fill(session.name)
    await expect(list.getByTestId("session-item")).toHaveCount(1)
    await expect(list.getByTestId("session-item")).toContainText(session.name)
  } finally {
    await Promise.all(others.map((o) => removeSession(o.id)))
  }
})

test("an edit waiting for permission shows the change itself", async ({ page }) => {
  await page.goto(`/#/s/${session.id}`)
  await expectCommand(session.id, "replay")
  await db.from("events").insert({
    session_id: "claude-1",
    csc_session: session.id,
    hook_event: "PermissionRequest",
    payload: { tool_name: "Edit", tool_input: { file_path: "/tmp/seraph-test/project/src/app.ts", old_string: "const a = 1", new_string: "const a = 2" } },
  })
  await sendScreen(session.id, [" Edit file", "", " Do you want to make this edit to app.ts?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel"].join("\n"))
  const tool = page.getByTestId("prompt-card").getByTestId("prompt-tool")
  await expect(tool).toContainText("src/app.ts")
  await expect(tool.getByTestId("diff")).toContainText("const a = 2")
  await expect(tool.getByTestId("diff")).toContainText("const a = 1")
})

test("a subagent's report reads as formatted text, and tapping the model opens /model", async ({ page }) => {
  await addMessages(session.id, [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "ag1", name: "Task", input: { description: "Survey the tests", subagent_type: "Explore", prompt: "List the test files" } }],
      },
    },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "ag1", content: [{ type: "text", text: "Found **3** test files." }] }] } },
  ])
  await page.goto(`/#/s/${session.id}`)
  const card = page.locator('[data-tool="Task"]')
  await expect(card).toContainText("Survey the tests")
  await card.getByRole("button").first().click()
  await expect(card.getByTestId("agent-report").locator("strong")).toHaveText("3")

  await page.getByTestId("model").click()
  await expectCommand(session.id, "prompt", (p) => p.text === "/model")
})

test("losing the connection shows Reconnecting until it's back", async ({ page, context }) => {
  await page.goto(`/#/s/${session.id}`)
  await expect(page.getByTestId("controller-status")).toBeVisible()
  await context.setOffline(true)
  await expect(page.getByTestId("connection-lost")).toBeVisible({ timeout: 10_000 })
  await context.setOffline(false)
  await expect(page.getByTestId("controller-status")).toBeVisible({ timeout: 30_000 })
})

test("the Changes tab lists every file Claude changed, without failed edits", async ({ page }) => {
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } })
  const result = (id: string, is_error = false) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: is_error ? "failed" : "ok", is_error }] } })
  await addMessages(session.id, [
    use("w1", "Write", { file_path: "/tmp/seraph-test/project/notes.md", content: "one\ntwo" }),
    result("w1"),
    use("e1", "Edit", { file_path: "/tmp/seraph-test/project/src/app.ts", old_string: "a", new_string: "b" }),
    result("e1"),
    use("e2", "Edit", { file_path: "/tmp/seraph-test/project/src/app.ts", old_string: "c", new_string: "d\ne" }),
    result("e2"),
    use("e3", "Edit", { file_path: "/tmp/seraph-test/project/broken.ts", old_string: "x", new_string: "y" }),
    result("e3", true),
  ])
  await page.goto(`/#/s/${session.id}`)
  await page.getByTestId("changes-tab").click()
  const changes = page.getByTestId("changes")
  await expect(changes).toContainText("2 files · +5 −2")
  await expect(changes.getByTestId("changed-file")).toHaveCount(2)
  await expect(changes).not.toContainText("broken.ts")
  const app = changes.getByTestId("changed-file").filter({ hasText: "src/app.ts" })
  await expect(app).toContainText("+3 −2")
  await app.getByRole("button").click()
  await expect(app.getByTestId("diff")).toHaveCount(2)
})

test("with two computers, the page names them and sends requests only to the one picked", async ({ page }) => {
  await db.from("controllers").upsert({ id: "test-box", hostname: "test-box", home: "/home/test", last_seen: new Date().toISOString() })
  try {
    await page.goto(`/#/s/${session.id}`)
    await expect(page.getByTestId("controller-status")).toContainText("2 computers")
    await page.getByRole("navigation", { name: "Sessions" }).getByTestId("new-session").click()
    const picker = page.getByTestId("machine")
    await expect(picker).toBeVisible()
    await picker.click()
    await page.getByRole("option", { name: "test-box" }).click()
    // The folder listing goes to test-box, and the real controller leaves it alone.
    let id = 0
    await expect
      .poll(async () => {
        const { data } = await db.from("commands").select("id").eq("kind", "list_dirs").eq("target", "test-box").order("id", { ascending: false }).limit(1)
        id = data?.[0]?.id ?? 0
        return id
      })
      .toBeGreaterThan(0)
    await page.waitForTimeout(3000)
    const { data } = await db.from("commands").select("status").eq("id", id).single()
    expect(data?.status).toBe("pending")
  } finally {
    await db.from("commands").delete().eq("target", "test-box")
    await db.from("controllers").delete().eq("id", "test-box")
  }
})

test("two devices on one session see each other's changes live", async ({ page, browser }) => {
  const phone = await browser.newPage({ storageState: "e2e/.auth/state.json" })
  try {
    await page.goto(`/#/s/${session.id}`)
    await phone.goto(`/#/s/${session.id}`)
    await expect(phone.getByTestId("session-title")).toHaveText(session.name)

    await page.getByTestId("rename").click()
    await page.getByTestId("rename-input").fill("Shared name")
    await page.getByTestId("rename-save").click()
    await expect(phone.getByTestId("session-title")).toHaveText("Shared name")

    await phone.getByTestId("composer").fill("sent from the phone")
    await phone.getByTestId("send").click()
    await expect(page.getByTestId("chat")).toContainText("sent from the phone")
  } finally {
    await phone.close()
  }
})

test("the sidebar lists devices, online first, and opens one to show its sessions by name", async ({ page }) => {
  await db.from("controllers").upsert({ id: "box-a", hostname: "box-a", home: "/home/a", last_seen: new Date().toISOString() })
  const onA = await fakeSession({ name: "on box a", hostname: "box-a" })
  const onB = await fakeSession({ name: "on box b", hostname: "box-b" })
  try {
    await page.goto(`/#/s/${onA.id}`)
    const list = page.getByRole("navigation", { name: "Sessions" })
    // The open session's device is shown first, with names only and no folders.
    await expect(list.getByTestId("device-name")).toHaveText("box-a")
    await expect(list.getByTestId("session-item")).toHaveText(/on box a/)
    await expect(list).not.toContainText("on box b")
    await expect(list).not.toContainText("/tmp/seraph-test")

    await list.getByTestId("devices-back").click()
    const devices = list.getByTestId("device-item")
    await expect(devices.filter({ hasText: "box-a" }).getByTitle("Online")).toBeAttached()
    await expect(devices.filter({ hasText: "box-b" }).getByTitle("Offline")).toBeAttached()
    // box-a is online, so it's listed before box-b.
    const names = await devices.allTextContents()
    expect(names.findIndex((n) => n.includes("box-a"))).toBeLessThan(names.findIndex((n) => n.includes("box-b")))

    await devices.filter({ hasText: "box-b" }).click()
    await expect(list.getByTestId("session-item")).toHaveText(/on box b/)
    await list.getByTestId("session-item").click()
    await expect(page.getByTestId("session-title")).toHaveText("on box b")
  } finally {
    await removeSession(onA.id)
    await removeSession(onB.id)
    await db.from("controllers").delete().eq("id", "box-a")
  }
})

test("ended sessions are folded away until opened", async ({ page }) => {
  const old = await fakeSession({ name: "an old one", status: "ended", ended_at: new Date().toISOString() })
  try {
    await page.goto(`/#/s/${session.id}`)
    const list = page.getByRole("navigation", { name: "Sessions" })
    await expect(list.getByTestId("ended-toggle")).toContainText("Ended (")
    await expect(list.getByText("an old one")).toHaveCount(0)
    await list.getByTestId("ended-toggle").click()
    await expect(list.getByText("an old one")).toBeVisible()
  } finally {
    await removeSession(old.id)
  }
})

test("a menu without numbers (the folder-trust question) can be answered", async ({ page }) => {
  await page.goto(`/#/s/${session.id}`)
  await expectCommand(session.id, "replay")
  // Lines that merely start with ❯, without Claude's "Enter to confirm" footer, aren't a menu.
  await sendScreen(session.id, "\x1b[2J\x1b[H❯ first thought\n  second thought\n")
  await page.waitForTimeout(1500)
  await expect(page.getByTestId("prompt-card")).toHaveCount(0)

  await sendScreen(
    session.id,
    [
      "\x1b[2J\x1b[H Accessing workspace:",
      "",
      " Quick safety check: Is this a project you created or one you trust?",
      "",
      " ❯ No, exit",
      "   Yes, I trust this folder",
      "",
      " Enter to confirm · Esc to cancel",
    ].join("\n"),
  )
  const card = page.getByTestId("prompt-card")
  await expect(card.getByTestId("prompt-choice")).toHaveCount(2)
  const yes = card.getByRole("button", { name: /Yes, I trust this folder/ })
  await expect(yes).toBeEnabled()
  await yes.click()
  await expectCommand(session.id, "keys", (p) => JSON.stringify(p.keys) === '["Down","Enter"]')
})

for (const size of ["desktop", "phone"] as const) {
  test(`only the chat scrolls; the bars stay put (${size})${size === "phone" ? " @mobile" : ""}`, async ({ page }) => {
    const lines = Array.from({ length: 40 }, (_, i) => ({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: `Line ${i + 1} of a long reply` }] },
    }))
    await addMessages(session.id, lines)
    await page.goto(`/#/s/${session.id}`)
    await expect(page.getByTestId("chat").getByText("Line 40 of a long reply")).toBeInViewport()
    // The page never scrolls; everything else stays on screen.
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(1)
    await expect(page.getByText("Seraph", { exact: true })).toBeInViewport()
    await expect(page.getByTestId("session-title")).toBeInViewport()
    await expect(page.getByTestId("composer")).toBeInViewport()
    if (size === "desktop") await expect(page.getByRole("navigation", { name: "Sessions" }).getByTestId("new-session")).toBeInViewport()
    // Scrolling the chat back up moves only the chat.
    await page.getByTestId("chat").getByText("Line 1 of a long reply").scrollIntoViewIfNeeded()
    await expect(page.getByTestId("chat").getByText("Line 1 of a long reply")).toBeInViewport()
    await expect(page.getByTestId("session-title")).toBeInViewport()
    await expect(page.getByTestId("composer")).toBeInViewport()
  })
}

test("the header shows context and plan usage from Claude's status line, live", async ({ page }) => {
  await page.goto(`/#/s/${session.id}`)
  await expect(page.getByTestId("session-title")).toBeVisible()
  await expect(page.getByTestId("usage")).toHaveCount(0)
  const resets = Math.floor(Date.now() / 1000) + 3600
  await db
    .from("sessions")
    .update({ usage: { context_percentage: 42, five_hour: { used_percentage: 80, resets_at: resets }, seven_day: { used_percentage: 12, resets_at: resets + 86400 * 3 } } })
    .eq("id", session.id)
  await expect(page.getByTestId("usage-context")).toContainText("42%")
  await expect(page.getByTestId("usage-five-hour")).toContainText("80%")
  await expect(page.getByTestId("usage-five-hour")).toContainText("resets")
  await expect(page.getByTestId("usage-weekly")).toContainText("12%")
})
