import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Session, SessionStatus } from "@/lib/types"

type Shown = SessionStatus | "paused"

/** The status to show: a paused session reads as paused, whatever its Claude is doing. */
export const shownStatus = (s: Pick<Session, "status" | "paused_at">): Shown => (s.paused_at ? "paused" : s.status)

const LABELS: Record<Shown, string> = {
  starting: "Starting",
  idle: "Ready",
  working: "Working",
  waiting: "Needs you",
  ended: "Ended",
  paused: "Paused",
}

const DOT: Record<Shown, string> = {
  starting: "bg-info",
  idle: "bg-success",
  working: "bg-highlight animate-pulse",
  waiting: "bg-warning",
  ended: "bg-muted-foreground/50",
  paused: "bg-info",
}

export function StatusBadge({ status, className }: { status: Shown; className?: string }) {
  return (
    <Badge variant="outline" className={cn("label gap-s2 normal-case", className)} data-status={status}>
      <span className={cn("size-2 rounded-full", DOT[status])} aria-hidden />
      {LABELS[status]}
    </Badge>
  )
}
