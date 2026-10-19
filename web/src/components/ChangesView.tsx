import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty"
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceLine, TraceTitle } from "@/components/ui/trace"
import { diffLines, shortPath, type FileChange } from "@/lib/tools"
import { Diff } from "./ToolCard"

/** Every file Claude changed in the session, each with its diffs. */
export function ChangesView({ files, cwd }: { files: FileChange[]; cwd: string }) {
  if (!files.length)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyDescription>Claude hasn't changed any files in this session yet.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  return (
    <div className="flex flex-col gap-s3 py-s5" data-testid="changes">
      <p className="label">
        {files.length} file{files.length > 1 ? "s" : ""} · +{added} −{removed}
      </p>
      <Trace className="gap-s3">
        {files.map((f) => (
          <TraceCollapsible key={f.path} data-testid="changed-file">
            <TraceCollapsibleTrigger className="w-full">
              <TraceLine className="min-w-0 flex-1 font-mono text-foreground">
                {/* Cut from the left so the file name stays visible. */}
                <TraceTitle className="flex-1 [direction:rtl]" title={f.path}>
                  <bdi>{shortPath(f.path, cwd)}</bdi>
                </TraceTitle>
                <TraceDescription className="text-xs">
                  +{f.added} −{f.removed}
                </TraceDescription>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent className="flex flex-col gap-s3 text-foreground">
              {f.changes.map((c, k) => (
                <div key={k} className="flex flex-col gap-s1">
                  {f.changes.length > 1 && <p className="label">{c.tool === "Write" ? "Wrote the file" : `Edit ${k + 1}`}</p>}
                  <Diff lines={diffLines(c.before, c.after)} />
                </div>
              ))}
            </TraceCollapsibleContent>
          </TraceCollapsible>
        ))}
      </Trace>
    </div>
  )
}
