import { ChevronRightIcon, FolderIcon, FolderOpenIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import { askDaemon } from "@/lib/commands"
import { cn } from "@/lib/utils"

type Entry = { name: string; path: string; children: boolean }
// Older controllers list folders by name only.
type Listed = string | { name: string; children?: boolean }
type Listing = { path: string; dirs: Listed[] }

/**
 * A computer's folders as a tree: only the folders seraph may use there,
 * one level at a time as you open them, and folders only, no files.
 */
export function FolderTree({
  machine,
  selected,
  onSelect,
  onError,
}: {
  machine: string
  selected: string
  onSelect: (path: string) => void
  onError: (message: string) => void
}) {
  const [roots, setRoots] = useState<Entry[] | null>(null)
  const [children, setChildren] = useState<Record<string, Entry[] | "loading">>({})

  const list = (path: string) => askDaemon<Listing>("list_dirs", { path }, machine)
  const entries = (l: Listing): Entry[] =>
    l.dirs.map((d) => (typeof d === "string" ? { name: d, path: `${l.path}/${d}`, children: true } : { name: d.name, path: `${l.path}/${d.name}`, children: d.children ?? true }))

  useEffect(() => {
    let gone = false
    setRoots(null)
    setChildren({})
    askDaemon<{ roots?: Entry[] } & Partial<Listing>>("list_dirs", { path: null }, machine)
      .then((r) => {
        if (gone) return
        if (r.roots) return setRoots(r.roots)
        // An older controller answers with its home folder: start the tree there.
        const home = r as Listing
        setRoots([{ name: home.path, path: home.path, children: true }])
        setChildren({ [home.path]: entries(home) })
      })
      .catch((e) => !gone && onError((e as Error).message))
    return () => {
      gone = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine])

  async function open(path: string) {
    if (children[path]) return
    setChildren((c) => ({ ...c, [path]: "loading" }))
    try {
      const l = await list(path)
      setChildren((c) => ({ ...c, [path]: entries(l) }))
    } catch (e) {
      setChildren((c) => {
        const { [path]: _, ...rest } = c
        return rest
      })
      onError((e as Error).message)
    }
  }

  function node(e: Entry, depth: number) {
    const kids = children[e.path]
    const picked = selected === e.path
    return (
      <Collapsible key={e.path} onOpenChange={(o) => o && open(e.path)}>
        <div
          className={cn("group/row flex items-center gap-s1 rounded-md pr-s2 text-sm hover:bg-accent", picked && "bg-accent font-medium")}
          style={{ paddingLeft: `calc(${depth} * var(--spacing-s5))` }}
        >
          {e.children ? (
            <CollapsibleTrigger className="group/trigger shrink-0 rounded-sm p-s1 text-muted-foreground hover:text-foreground" aria-label={`Open ${e.name}`} data-testid="folder-toggle">
              <ChevronRightIcon className="size-4 transition-transform duration-[144ms] ease-slag group-data-[state=open]/trigger:rotate-90" />
            </CollapsibleTrigger>
          ) : (
            <span className="size-[22px] shrink-0" aria-hidden />
          )}
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-s2 py-s2 text-left"
            onClick={() => onSelect(e.path)}
            aria-pressed={picked}
            data-testid="folder"
            data-path={e.path}
          >
            {picked ? <FolderOpenIcon className="size-4 shrink-0 text-highlight" /> : <FolderIcon className="size-4 shrink-0 text-muted-foreground" />}
            <span className="truncate">{e.name}</span>
          </button>
        </div>
        <CollapsibleContent>
          {kids === "loading" ? (
            <Spinner className="my-s1 size-3 text-muted-foreground" style={{ marginLeft: `calc(${depth + 1} * var(--spacing-s5) + 22px)` }} />
          ) : (
            kids?.map((k) => node(k, depth + 1))
          )}
        </CollapsibleContent>
      </Collapsible>
    )
  }

  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border p-s2" data-testid="folders" aria-label="Folders">
      {roots === null ? <Spinner className="m-s2 text-muted-foreground" /> : roots.map((r) => node(r, 0))}
    </div>
  )
}
