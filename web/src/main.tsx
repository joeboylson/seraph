import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import { connect } from "./lib/supabase"

// Dark follows the OS.
const dark = window.matchMedia("(prefers-color-scheme: dark)")
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches)
applyTheme()
dark.addEventListener("change", applyTheme)

const root = createRoot(document.getElementById("root")!)

connect()
  .then(async () => {
    // Loaded after connecting: the app's modules use the client as they load.
    const { AuthGate } = await import("./components/AuthGate.tsx")
    root.render(
      <StrictMode>
        <AuthGate />
      </StrictMode>,
    )
  })
  .catch((e: Error) => {
    root.render(
      <main className="mx-auto flex max-w-[610px] flex-col gap-s4 px-s5 py-s8">
        <p className="label">Can't connect</p>
        <h1 className="text-title font-medium tracking-[-0.03em]">Seraph can't reach Supabase</h1>
        <p className="text-lead text-muted-foreground">{e.message}</p>
        <p className="text-muted-foreground">
          On the machine running seraph, <code className="font-mono">seraph doctor</code> checks each part.
        </p>
      </main>,
    )
  })
