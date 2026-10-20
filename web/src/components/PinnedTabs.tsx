import { XIcon } from "lucide-react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { Session } from "@/lib/types"
import { sessionTitle } from "./SessionList"
import { StatusDot, shownStatus } from "./StatusBadge"

/** Pinned sessions as tabs at the top, for switching between your main ones. */
export function PinnedTabs({
  sessions,
  pins,
  selectedId,
  onSelect,
  onUnpin,
}: {
  sessions: Session[]
  pins: string[]
  selectedId: string | null
  onSelect: (id: string) => void
  onUnpin: (id: string) => void
}) {
  const pinned = pins.flatMap((id) => sessions.filter((s) => s.id === id))
  if (!pinned.length) return null
  return (
    // Scrolls sideways when the tabs don't fit, e.g. on a phone.
    <Tabs value={selectedId ?? ""} onValueChange={onSelect} className="min-w-0 overflow-x-auto [scrollbar-width:none]">
      <TabsList aria-label="Pinned sessions" data-testid="pinned-tabs">
        {pinned.map((s) => (
          <TabsTrigger key={s.id} value={s.id} className="group/tab max-w-[144px] gap-s2 pr-s2" data-testid="pinned-tab">
            <StatusDot status={shownStatus(s)} />
            <span className="truncate">{sessionTitle(s)}</span>
            <span
              role="button"
              tabIndex={-1}
              aria-label={`Unpin ${sessionTitle(s)}`}
              title="Unpin"
              className="rounded-sm p-0.5 text-muted-foreground opacity-0 group-hover/tab:opacity-100 group-data-[state=active]/tab:opacity-100 hover:text-foreground"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onUnpin(s.id)
              }}
              data-testid="unpin-tab"
            >
              <XIcon className="size-3" />
            </span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
