import { BellRingIcon } from "lucide-react"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { deviceName, useLastReplies } from "@/hooks/data"
import { speakable } from "@/hooks/useVoice"
import type { Controller, MessageRow, Session } from "@/lib/types"
import { cn, timeAgo } from "@/lib/utils"
import { sessionTitle } from "./SessionList"
import { StatusBadge, shownStatus } from "./StatusBadge"
import { UsageBars } from "./UsageBars"

// Who needs you first, then what's busy, then the rest.
const ORDER: Record<string, number> = { waiting: 0, working: 1, starting: 2, idle: 3, paused: 4 }

function replyText(m: MessageRow | undefined) {
  const content = m?.data.message?.content
  const text = Array.isArray(content) ? content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ") : ""
  return speakable(text)
}

/** Every running session on every computer, the ones waiting on you first. */
export function Overview({ sessions, devices, onOpen }: { sessions: Session[]; devices: Controller[]; onOpen: (id: string) => void }) {
  const live = sessions
    .filter((s) => s.status !== "ended" || s.paused_at)
    .sort((a, b) => ORDER[shownStatus(a)] - ORDER[shownStatus(b)] || b.updated_at.localeCompare(a.updated_at))
  const replies = useLastReplies(live.map((s) => s.id))
  const waiting = live.filter((s) => shownStatus(s) === "waiting").length
  // The plan's limits are the same for every session: show the freshest.
  const usage = sessions
    .filter((s) => s.usage)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]?.usage

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-s5 overflow-y-auto pb-s6" data-testid="overview">
      <header className="flex flex-col gap-s2 border-b pb-s4">
        <h1 className="text-title font-medium tracking-[-0.03em]">{waiting ? `${waiting} need${waiting === 1 ? "s" : ""} you` : "Nothing needs you"}</h1>
        <p className="label">
          {live.length} running across {new Set(live.map((s) => s.hostname)).size || 0} device{new Set(live.map((s) => s.hostname)).size === 1 ? "" : "s"}
        </p>
        <UsageBars usage={usage ?? null} />
      </header>
      {live.length ? (
        <ItemGroup className="gap-s3">
          {live.map((s) => {
            const status = shownStatus(s)
            const reply = replyText(replies[s.id])
            return (
              <Item key={s.id} variant="outline" asChild className={cn(status === "waiting" && "border-highlight")}>
                <button type="button" onClick={() => onOpen(s.id)} className="w-full text-left" data-testid="overview-session" data-status={status}>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="flex items-center gap-s2">
                      {status === "waiting" && <BellRingIcon className="size-4 text-highlight" />}
                      <span className="truncate">{sessionTitle(s)}</span>
                      <span className="label normal-case">{deviceName(s.hostname, devices)}</span>
                    </ItemTitle>
                    <ItemDescription className="line-clamp-2" data-testid="overview-reply">
                      {reply || "No reply yet."}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions className="flex-col items-end gap-s1">
                    <StatusBadge status={status} />
                    <span className="label normal-case">{timeAgo(s.updated_at)}</span>
                  </ItemActions>
                </button>
              </Item>
            )
          })}
        </ItemGroup>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No sessions running</EmptyTitle>
            <EmptyDescription>Start one from a device, or run seraph claude in a terminal.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  )
}
