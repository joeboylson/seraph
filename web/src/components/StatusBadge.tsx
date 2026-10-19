import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { SessionStatus } from "@/lib/types"

const LABELS: Record<SessionStatus, string> = {
  starting: "Starting",
  idle: "Ready",
  working: "Working",
  waiting: "Needs you",
  ended: "Ended",
}

const DOT: Record<SessionStatus, string> = {
  starting: "bg-info",
  idle: "bg-success",
  working: "bg-highlight animate-pulse",
  waiting: "bg-warning",
  ended: "bg-muted-foreground/50",
}

export function StatusBadge({ status, className }: { status: SessionStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn("label gap-s2 normal-case", className)} data-status={status}>
      <span className={cn("size-2 rounded-full", DOT[status])} aria-hidden />
      {LABELS[status]}
    </Badge>
  )
}
