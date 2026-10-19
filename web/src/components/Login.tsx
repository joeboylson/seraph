import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { db } from "@/lib/supabase"

const EMAIL_KEY = "csc:email"

function savedEmail() {
  try {
    return localStorage.getItem(EMAIL_KEY) ?? ""
  } catch {
    return ""
  }
}

/** Sign in with a code sent by email. Only accounts made with `seraph user add` get one. */
export function Login() {
  const [email, setEmail] = useState(savedEmail)
  const [code, setCode] = useState("")
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function sendCode(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    // The email holds a code, a link, or both, depending on the project's
    // email template. The link comes back to this page and signs in here.
    const { error } = await db.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false, emailRedirectTo: `${location.origin}/` },
    })
    setBusy(false)
    // Sign-ups are off, so an unknown address comes back as "signups not allowed".
    if (error?.code === "otp_disabled" || error?.code === "signup_disabled") {
      setError(`${email.trim()} can't sign in here. On your computer, run: seraph user add ${email.trim()}`)
    } else if (error?.code === "over_email_send_rate_limit") {
      setError("A code was sent moments ago. Wait a few seconds, then try again.")
    } else if (error) {
      setError(error.message)
    } else {
      try {
        localStorage.setItem(EMAIL_KEY, email.trim())
      } catch {
        // remembering the address is only a convenience
      }
      setSent(true)
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await db.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" })
    setBusy(false)
    if (error) setError(error.code === "otp_expired" ? "That code is wrong or has expired. Check it, or send a new one." : error.message)
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-[377px] flex-col justify-center gap-s5 px-s4 py-s8">
      <div className="flex flex-col gap-s3">
        <p className="label">Seraph</p>
        <h1 className="text-title font-medium tracking-[-0.03em]">Sign in</h1>
      </div>

      {!sent ? (
        <form onSubmit={sendCode} className="flex flex-col gap-s4">
          <Field>
            <FieldLabel htmlFor="f-email" className="label">Email</FieldLabel>
            <Input id="f-email" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} data-testid="login-email" />
          </Field>
          <Button type="submit" className="w-fit rounded-full" disabled={busy || !email.trim()}>
            {busy ? "Sending…" : "Send code"}
          </Button>
        </form>
      ) : (
        <form onSubmit={verify} className="flex flex-col gap-s4">
          <p className="text-muted-foreground">
            We emailed {email.trim()}. Tap the link in it, or type its code here. It can take a minute to arrive. No email? Run{" "}
            <code className="font-mono">seraph user code {email.trim()}</code> on your computer.
          </p>
          <Field>
            <FieldLabel htmlFor="f-code" className="label">Code</FieldLabel>
            <Input id="f-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="font-mono tracking-[0.2em]"
              data-testid="login-code"
            />
          </Field>
          <div className="flex items-center gap-s3">
            <Button type="submit" className="rounded-full" disabled={busy || !code.trim()}>
              {busy ? "Checking…" : "Sign in"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="rounded-full"
              onClick={() => {
                setSent(false)
                setCode("")
                setError(null)
              }}
            >
              Use another email
            </Button>
          </div>
        </form>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </main>
  )
}
