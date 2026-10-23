import { cn } from "cn";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useI18n } from "@/core/useI18n";
import { generatedChecksumLines, planText } from "./change-plan-presentation";
import { diffLines, type DiffLine } from "./diff";

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div
      className={cn(
        "grid grid-cols-[1.5rem_minmax(0,1fr)] px-3 py-0.5",
        line.type === "added" && "bg-emerald-50 text-emerald-800",
        line.type === "removed" && "bg-red-50 text-red-800",
      )}
    >
      <span>{line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}</span>
      {line.content || " "}
    </div>
  );
}

export function WorkspaceChangeDiff({
  before,
  after,
  target,
}: {
  before: string;
  after: string;
  target?: string;
}) {
  const { locale } = useI18n();
  const beforeChecksums = generatedChecksumLines(before, target);
  const afterChecksums = generatedChecksumLines(after, target);
  const chunks: Array<{ folded: boolean; lines: DiffLine[] }> = [];
  let beforeLine = 0;
  let afterLine = 0;
  for (const line of diffLines(before, after)) {
    const folded =
      line.type === "same"
        ? beforeChecksums.has(beforeLine) && afterChecksums.has(afterLine)
        : line.type === "removed"
          ? beforeChecksums.has(beforeLine)
          : afterChecksums.has(afterLine);
    if (line.type !== "added") beforeLine++;
    if (line.type !== "removed") afterLine++;
    const previous = chunks.at(-1);
    if (previous?.folded === folded) previous.lines.push(line);
    else chunks.push({ folded, lines: [line] });
  }
  return (
    <div className="overflow-auto rounded-lg border border-border bg-muted/30 font-mono whitespace-pre">
      {chunks.map((chunk, index) =>
        chunk.folded ? (
          <Collapsible key={index}>
            <CollapsibleTrigger className="w-full cursor-pointer px-3 py-2 text-left font-sans whitespace-normal text-muted-foreground">
              {planText(locale, "checksums", chunk.lines.length)}
            </CollapsibleTrigger>
            <CollapsibleContent>
              {chunk.lines.map((line, row) => (
                <DiffRow key={row} line={line} />
              ))}
            </CollapsibleContent>
          </Collapsible>
        ) : (
          chunk.lines.map((line, row) => <DiffRow key={`${index}-${row}`} line={line} />)
        ),
      )}
    </div>
  );
}
