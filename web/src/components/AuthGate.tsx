import type { Session } from "@supabase/supabase-js"
import { lazy, Suspense, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Login } from "@/components/Login"
import { signOut } from "@/lib/push"
import { db } from "@/lib/supabase"

// Loaded only once signed in, so nothing subscribes to data before then.
const App = lazy(() => import("@/App"))

type State = { kind: "loading" } | { kind: "signed-out" } | { kind: "not-member"; email?: string } | { kind: "in" } | { kind: "error"; message: string }

/** Shows the login screen until someone on the members list signs in. */
export function AuthGate() {
  const [state, setState] = useState<State>({ kind: "loading" })

  useEffect(() => {
    async function check(session: Session | null) {
      if (!session) return setState({ kind: "signed-out" })
      const { data, error } = await db.rpc("is_member")
      if (error) setState({ kind: "error", message: error.message })
      else setState(data ? { kind: "in" } : { kind: "not-member", email: session.user.email })
    }
    const { data } = db.auth.onAuthStateChange((event, session) => {
      // Token refreshes don't change who's signed in. Calling Supabase from
      // inside this callback can deadlock, so check on the next tick.
      if (event === "INITIAL_SESSION" || event === "SIGNED_IN" || event === "SIGNED_OUT") setTimeout(() => check(session))
    })
    return () => data.subscription.unsubscribe()
  }, [])

  if (state.kind === "loading") return null
  if (state.kind === "signed-out") return <Login />
  if (state.kind === "in")
    return (
      <Suspense fallback={null}>
        <App />
      </Suspense>
    )
  return (
    <Empty className="min-h-dvh">
      <EmptyHeader className="max-w-[610px]">
        <p className="label">{state.kind === "error" ? "Can't connect" : "Not allowed"}</p>
        <EmptyTitle>
          <h1 className="text-title font-medium tracking-[-0.03em]">
            {state.kind === "error" ? "Couldn't check your account" : `${state.email ?? "This account"} can't use this page`}
          </h1>
        </EmptyTitle>
        <EmptyDescription className="text-lead">
          {state.kind === "error" ? (
            state.message
          ) : (
            <>
              On your computer, run <code className="font-mono">seraph user add {state.email}</code>, then sign in again.
            </>
          )}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" className="rounded-full" onClick={() => signOut()}>
          Sign out
        </Button>
      </EmptyContent>
    </Empty>
  )
}
