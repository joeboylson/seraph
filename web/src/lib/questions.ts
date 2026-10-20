import type { HookEvent } from "./types"

/** One question from Claude's AskUserQuestion tool. */
export type Question = {
  question: string
  header?: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

/** What the person picked for one question: option labels, or their own words. */
export type Answer = { picked: string[]; other?: string }

/** The questions Claude is waiting on, or null. A round is answered once its PostToolUse arrives. */
export function pendingQuestions(events: HookEvent[]): { id: string; questions: Question[] } | null {
  const done = new Set(
    events.filter((e) => e.hook_event === "PostToolUse" || e.hook_event === "PostToolUseFailure").map((e) => e.payload.tool_use_id as string),
  )
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.hook_event !== "PreToolUse" || e.payload.tool_name !== "AskUserQuestion") continue
    const id = e.payload.tool_use_id as string | undefined
    const questions = (e.payload.tool_input as { questions?: Question[] } | undefined)?.questions
    if (!id || done.has(id) || !Array.isArray(questions) || !questions.length) return null
    return { id, questions }
  }
  return null
}

/**
 * The keys that give these answers in Claude's question menu, as a series of
 * `keys` commands (one per step, so the menu redraws in between):
 * - pick one: the option's number, which also moves on (or answers, if it's
 *   the only question);
 * - your own words: the number after the options ("Type something"), the
 *   text, then Enter;
 * - pick several: each option's number toggles it, then Tab moves on; with
 *   your own words too, also tick "Type something", move down to it, type,
 *   then Tab and Enter;
 * - with several questions, or any pick-several one, a review step follows:
 *   1 submits.
 */
export function answerKeys(questions: Question[], answers: Answer[]): ({ keys: string[] } | { data: string })[] {
  const steps: ({ keys: string[] } | { data: string })[] = []
  questions.forEach((q, i) => {
    const a = answers[i] ?? { picked: [] }
    const number = (label: string) => String(q.options.findIndex((o) => o.label === label) + 1)
    if (q.multiSelect && a.other?.trim()) {
      // Tick "Type something" too, then move the cursor (still on the first
      // option) down to it to type; Tab and Enter finish the question. Tab
      // and Enter go apart: sent together, Enter lands before Tab is done.
      const typeIt = String(q.options.length + 1)
      steps.push({ keys: [...a.picked.map(number), typeIt] }, { keys: Array(q.options.length).fill("Down") }, { data: a.other.trim() }, { keys: ["Tab"] }, { keys: ["Enter"] })
    } else if (q.multiSelect) {
      steps.push({ keys: [...a.picked.map(number), "Tab"] })
    } else if (a.other?.trim()) {
      steps.push({ keys: [String(q.options.length + 1)] }, { data: a.other.trim() }, { keys: ["Enter"] })
    } else {
      steps.push({ keys: [number(a.picked[0])] })
    }
  })
  if (questions.length > 1 || questions.some((q) => q.multiSelect)) steps.push({ keys: ["1"] })
  return steps
}
