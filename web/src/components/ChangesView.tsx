import { ChevronRightIcon } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { diffLines, shortPath, type FileChange } from "@/lib/tools"
import { Diff } from "./ToolCard"

/** Every file Claude changed in the session, each with its diffs. */
export function ChangesView({ files, cwd }: { files: FileChange[]; cwd: string }) {
  if (!files.length) return <p className="py-s7 text-muted-foreground">Claude hasn't changed any files in this session yet.</p>
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  return (
    <div className="flex flex-col gap-s3 py-s5" data-testid="changes">
      <p className="label">
        {files.length} file{files.length > 1 ? "s" : ""} · +{added} −{removed}
      </p>
      <ul className="flex flex-col gap-s3">
        {files.map((f) => (
          <li key={f.path}>
            <Collapsible className="rounded-md border" data-testid="changed-file">
              <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-s3 px-s4 py-s3 text-left text-sm">
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-[144ms] group-data-[state=open]:rotate-90" />
                {/* Cut from the left so the file name stays visible. */}
                <span className="min-w-0 flex-1 truncate text-left font-mono [direction:rtl]" title={f.path}>
                  <bdi>{shortPath(f.path, cwd)}</bdi>
                </span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  +{f.added} −{f.removed}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col gap-s3 border-t px-s4 py-s3">
                {f.changes.map((c, k) => (
                  <div key={k} className="flex flex-col gap-s1">
                    {f.changes.length > 1 && (
                      <p className="label">
                        {c.tool === "Write" ? "Wrote the file" : `Edit ${k + 1}`}
                      </p>
                    )}
                    <Diff lines={diffLines(c.before, c.after)} />
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>
          </li>
        ))}
      </ul>
    </div>
  )
}
