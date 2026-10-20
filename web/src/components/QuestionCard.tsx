import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card"
import { Kbd } from "@/components/ui/kbd"
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire"
import { sendCommand, sendKeys } from "@/lib/commands"
import { answerKeys, type Answer, type Question } from "@/lib/questions"

const OTHER = "__other"
// Time for Claude's menu to redraw between steps.
const STEP_MS = 400
// Still waiting this long after sending: the keys didn't land.
const STUCK_MS = 10_000

/** Claude's AskUserQuestion as a form: one question at a time, then the keys go to the terminal. */
export function QuestionCard({ sessionId, questions, onOpenTerminal }: { sessionId: string; questions: Question[]; onOpenTerminal: () => void }) {
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(() => ({ picked: [] })))
  const [state, setState] = useState<"asking" | "sending" | "sent" | "stuck">("asking")

  useEffect(() => {
    if (state !== "sent") return
    const t = setTimeout(() => setState("stuck"), STUCK_MS)
    return () => clearTimeout(t)
  }, [state])

  const set = (i: number, change: (a: Answer) => Answer) => setAnswers((all) => all.map((a, j) => (j === i ? change(a) : a)))

  async function send() {
    setState("sending")
    try {
      for (const [n, step] of answerKeys(questions, answers).entries()) {
        if (n) await new Promise((r) => setTimeout(r, STEP_MS))
        if ("keys" in step) await sendKeys(sessionId, step.keys)
        else await sendCommand(sessionId, "keys", step)
      }
      setState("sent")
    } catch {
      setState("stuck")
    }
  }

  return (
    <Card role="region" className="max-h-[70dvh] min-h-0 shrink overflow-auto text-body ring-highlight" data-testid="question-card" aria-label="Claude is asking">
      <CardHeader>
        <CardDescription className="label">Claude is asking</CardDescription>
      </CardHeader>
      <CardContent>
        <Questionnaire
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
          shortcuts="numbers"
        >
          {questions.length > 1 && <QuestionnaireProgress />}
          {questions.map((q, i) => {
            const a = answers[i]
            const other = a.other !== undefined
            return (
              <QuestionnaireItem key={i} name={`q${i}`} multiple={q.multiSelect} required data-testid="question">
                <QuestionnaireTitle className="text-body font-medium">{q.question}</QuestionnaireTitle>
                <QuestionnaireChoices>
                  {q.options.map((o) => (
                    <QuestionnaireChoice
                      key={o.label}
                      value={o.label}
                      checked={a.picked.includes(o.label)}
                      onChange={(e) =>
                        set(i, (a) =>
                          q.multiSelect
                            ? { ...a, picked: e.target.checked ? [...a.picked, o.label] : a.picked.filter((p) => p !== o.label) }
                            : { picked: [o.label] },
                        )
                      }
                      data-testid="question-option"
                    >
                      {o.label}
                      {o.description && <QuestionnaireChoiceDescription>{o.description}</QuestionnaireChoiceDescription>}
                    </QuestionnaireChoice>
                  ))}
                  {/* Your own answer: what Claude's menu calls "Type something". */}
                  <QuestionnaireChoice
                    value={OTHER}
                    checked={other}
                    onChange={(e) =>
                      set(i, (a) => (q.multiSelect ? { picked: a.picked, other: e.target.checked ? "" : undefined } : { picked: [], other: "" }))
                    }
                    data-testid="question-other"
                  >
                    Something else
                  </QuestionnaireChoice>
                </QuestionnaireChoices>
                {other && (
                  <QuestionnaireInput
                    value={a.other}
                    onChange={(e) => set(i, (a) => ({ picked: q.multiSelect ? a.picked : [], other: e.target.value }))}
                    placeholder="Your answer"
                    autoFocus
                    data-testid="question-other-text"
                  />
                )}
              </QuestionnaireItem>
            )
          })}
          <QuestionnaireActions>
            <QuestionnairePrevious variant="ghost" className="rounded-full">Back</QuestionnairePrevious>
            <QuestionnaireNext className="rounded-full">Next</QuestionnaireNext>
            <QuestionnaireSubmit
              className="rounded-full"
              disabled={state === "sending" || state === "sent" || answers.some((a, i) => (questions[i].multiSelect ? false : !a.picked.length && !a.other?.trim()))}
              data-testid="question-submit"
            >
              {state === "sending" || state === "sent" ? "Sending…" : "Answer"}
            </QuestionnaireSubmit>
          </QuestionnaireActions>
        </Questionnaire>
        <div className="flex flex-wrap items-center gap-s3 pt-s4 text-sm text-muted-foreground">
          {state === "stuck" ? (
            <span data-testid="question-stuck">
              That didn't go through.{" "}
              <Button variant="link" className="h-auto p-0 text-sm underline" onClick={onOpenTerminal}>
                Answer in the terminal
              </Button>
            </span>
          ) : (
            <Button variant="ghost" size="sm" className="rounded-full" onClick={() => sendKeys(sessionId, ["Escape"])} data-testid="question-cancel">
              Cancel <Kbd>Esc</Kbd>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
