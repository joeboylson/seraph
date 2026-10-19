/** `key` labels the button; `keys` are what's typed to pick it. */
export type Choice = { key: string; label: string; selected: boolean; keys: string[] }
export type Prompt = {
  title: string
  choices: Choice[]
  hint: string | null
  /** For a panel with no choices (e.g. /cost), the text it shows. */
  body?: string[]
}

const CHOICE = /^\s*(❯|›|>)?\s*(\d{1,2})\.\s+(.+?)\s*$/
const RULE = /^[\s─━╌═┄-]*$/

/**
 * Find a numbered menu at the bottom of Claude's screen, such as a
 * permission prompt, a question from Claude, or a /model picker.
 * Returns null when there is none.
 */
export function readPrompt(lines: string[]): Prompt | null {
  let end = lines.length - 1
  while (end >= 0 && !lines[end].trim()) end--
  const bottom = lines.slice(Math.max(0, end - 30), end + 1)

  const panel = readCursorMenu(bottom) ?? readPanel(bottom)

  // The menu must sit near the bottom: only a short footer may follow it.
  let last = -1
  for (let i = bottom.length - 1; i >= Math.max(0, bottom.length - 8); i--) {
    if (CHOICE.test(bottom[i])) {
      last = i
      break
    }
  }
  if (last === -1) return panel

  const choices: Choice[] = []
  let first = last
  for (let i = last; i >= 0; i--) {
    const m = bottom[i].match(CHOICE)
    if (m) {
      choices.unshift({ key: m[2], label: m[3], selected: Boolean(m[1]), keys: [m[2]] })
      first = i
    } else if (bottom[i].trim() && !/^\s{3,}\S/.test(bottom[i])) {
      break // a wrapped choice label is indented; anything else ends the menu
    }
  }
  // Numbers must run 1, 2, 3... or it's just a numbered list in Claude's reply.
  if (choices.length < 2 || choices.some((c, i) => c.key !== String(i + 1))) return panel

  let title = ""
  for (let i = first - 1; i >= 0; i--) {
    const text = bottom[i].trim()
    if (text && !RULE.test(text)) {
      title = text
      break
    }
  }
  const hint = bottom.slice(last + 1).map((l) => l.trim()).find((l) => l && !RULE.test(l)) ?? null
  return { title, choices, hint }
}

const CURSOR = /^(\s*)(❯|›)\s+(\S.*?)\s*$/
// Footers under menus picked with the arrow keys and Enter.
const MENU_FOOTER = /enter to (confirm|select)|to navigate|↑\s*\/?\s*↓/i

/**
 * A menu without numbers, like the folder-trust question: a ❯ marks the
 * current option and Enter picks it. Each choice moves there, then presses
 * Enter. Only counts with Claude's "Enter to confirm" footer just below, so
 * a reply that happens to start with ❯ isn't mistaken for one.
 */
function readCursorMenu(bottom: string[]): Prompt | null {
  const footer = bottom.findLastIndex((l) => MENU_FOOTER.test(l))
  if (footer === -1 || bottom.length - footer > 3) return null
  const cursor = bottom.slice(0, footer).findLastIndex((l) => CURSOR.test(l))
  if (cursor === -1 || footer - cursor > 12) return null
  const column = bottom[cursor].indexOf(bottom[cursor].match(CURSOR)![3])
  // An option's text starts in the same column as the selected one's.
  const isOption = (l: string) => l.length > column && l[column] !== " " && l.slice(0, column).replace(/[❯›]/, "").trim() === ""
  let first = cursor
  while (first > 0 && isOption(bottom[first - 1])) first--
  let last = cursor
  while (last + 1 < footer && isOption(bottom[last + 1])) last++
  if (last === first) return null

  const selected = cursor - first
  const choices: Choice[] = bottom.slice(first, last + 1).map((line, i) => {
    const moves = Array(Math.abs(i - selected)).fill(i > selected ? "Down" : "Up")
    return { key: String(i + 1), label: line.slice(column).trim(), selected: i === selected, keys: [...moves, "Enter"] }
  })
  let title = ""
  for (let i = first - 1; i >= 0; i--) {
    const text = bottom[i].trim()
    if (text && !RULE.test(text)) {
      title = text
      break
    }
  }
  return { title, choices, hint: bottom[footer].trim() }
}

// Footers Claude shows under panels that wait for Esc.
const PANEL_FOOTER = /^Esc to (cancel|close|exit|go back)\b|^Press Esc\b/i

/** A panel such as /cost or /status that has no numbered choices but waits for Esc. */
function readPanel(bottom: string[]): Prompt | null {
  const footer = bottom.findLastIndex((l) => PANEL_FOOTER.test(l.trim()))
  if (footer === -1 || bottom.length - footer > 3) return null
  // The panel is everything above the footer back to the nearest rule.
  let start = 0
  for (let i = footer - 1; i >= 0; i--) {
    if (RULE.test(bottom[i]) && bottom[i].trim()) {
      start = i + 1
      break
    }
  }
  const body = bottom.slice(start, footer)
  while (body.length && !body[0].trim()) body.shift()
  while (body.length && !body.at(-1)!.trim()) body.pop()
  return { title: "", choices: [], hint: bottom[footer].trim(), body: body.slice(-24) }
}

// Claude's status line names the permission mode, e.g.
// "⏸ manual mode on" or "⏵⏵ accept edits on (shift+tab to cycle)".
const MODE_LINE = /(?:⏸|⏵⏵|⏵)\s+([a-z' ]+?)\s+on\b/i
const MODE_NAMES: Record<string, string> = {
  manual: "Ask before edits",
  "manual mode": "Ask before edits",
  "accept edits": "Accept edits",
  "plan mode": "Plan mode",
  plan: "Plan mode",
  "auto mode": "Auto",
  auto: "Auto",
  "bypass permissions": "Bypass permissions",
}

/** The permission mode shown in Claude's status line, or null if it isn't on screen. */
export function readMode(lines: string[]): string | null {
  // The status line sits just under Claude's content, which may not reach
  // the bottom of the window, so skip blank rows first.
  let end = lines.length - 1
  while (end >= 0 && !lines[end].trim()) end--
  for (let i = end; i >= Math.max(0, end - 5); i--) {
    const m = lines[i].match(MODE_LINE)
    if (m) {
      const name = m[1].trim().toLowerCase()
      return MODE_NAMES[name] ?? name.charAt(0).toUpperCase() + name.slice(1)
    }
  }
  return null
}
