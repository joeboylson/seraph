import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import type { SessionUsage } from "@/lib/types"

/** When a limit resets: a time today, else a weekday and time. */
function resetsAt(epochSeconds: number) {
  const at = new Date(epochSeconds * 1000)
  const sameDay = at.toDateString() === new Date().toDateString()
  return at.toLocaleString(undefined, sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" })
}

function Bar({ label, percent, resets, testId }: { label: string; percent: number; resets?: number | null; testId: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-s1" data-testid={testId} title={resets ? `Resets ${resetsAt(resets)}` : undefined}>
      <span className="label flex items-baseline justify-between gap-s3">
        <span>{label}</span>
        <span className="normal-case">{percent}%</span>
      </span>
      <Progress
        value={percent}
        aria-label={`${label} ${percent}% used`}
        className={cn(
          "w-[89px]",
          percent >= 90 ? "[&>[data-slot=progress-indicator]]:bg-destructive" : percent >= 75 && "[&>[data-slot=progress-indicator]]:bg-warning",
        )}
      />
      {resets && <span className="label normal-case">resets {resetsAt(resets)}</span>}
    </div>
  )
}

/** Context used, and the plan's 5-hour and weekly limits, as Claude's status line last reported them. */
export function UsageBars({ usage }: { usage: SessionUsage | null }) {
  if (!usage) return null
  const { context_percentage: context, five_hour: fiveHour, seven_day: week } = usage
  if (context == null && !fiveHour && !week) return null
  return (
    <div className="flex flex-wrap gap-s5 pt-s3" data-testid="usage">
      {context != null && <Bar label="Context" percent={context} testId="usage-context" />}
      {fiveHour && <Bar label="5-hour" percent={fiveHour.used_percentage} resets={fiveHour.resets_at} testId="usage-five-hour" />}
      {week && <Bar label="Weekly" percent={week.used_percentage} resets={week.resets_at} testId="usage-weekly" />}
    </div>
  )
}
