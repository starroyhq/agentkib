import { useI18n } from "@/core/useI18n";
import { FileCode2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CatalogAsset } from "@/core/types";
import { AgentSectionFeedback } from "./AgentSectionFeedback";

export function AgentAssetsPanel({
  homeAssets,
  assetKinds,
  visibleAssets,
  query,
  kind,
  loading,
  error,
  onQueryChange,
  onKindChange,
  onRetry,
}: {
  homeAssets: CatalogAsset[];
  assetKinds: string[];
  visibleAssets: CatalogAsset[];
  query: string;
  kind: string;
  loading: boolean;
  error: boolean;
  onQueryChange: (query: string) => void;
  onKindChange: (kind: string) => void;
  onRetry: () => void;
}) {
  const { tr } = useI18n();
  if (loading || error) return <AgentSectionFeedback error={error} onRetry={onRetry} />;

  return (
    <div className="grid gap-4 p-5">
      <div className="grid gap-3 rounded-xl border border-border bg-muted/20 p-3 md:grid-cols-[minmax(0,1fr)_auto]">
        <label className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-3">
          <Search size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <Input
            className="h-9 border-0 px-0 shadow-none focus-visible:ring-0"
            aria-label={tr("catalog.searchPlaceholder")}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={tr("catalog.searchPlaceholder")}
          />
        </label>
        {assetKinds.length > 1 && (
          <Select
            value={kind}
            onValueChange={(value) => {
              if (value !== null) onKindChange(String(value));
            }}
          >
            <SelectTrigger
              aria-label={tr("catalog.allTypes")}
              className="h-9 w-full md:w-auto md:min-w-[150px]"
            >
              <SelectValue>
                {kind === "all" ? tr("catalog.allTypes") : tr(`status.asset.${kind}`)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{tr("catalog.allTypes")}</SelectLabel>
                <SelectItem value="all">{tr("catalog.allTypes")}</SelectItem>
                {assetKinds.map((value) => (
                  <SelectItem key={value} value={value}>
                    {tr(`status.asset.${value}`)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="grid gap-2">
        {visibleAssets.map((asset) => (
          <div
            className="grid min-h-[64px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-border bg-background px-3 py-2 text-sm"
            key={asset.id}
          >
            <span className="grid size-8 place-items-center rounded-lg bg-muted/40">
              <FileCode2 size={15} className="text-muted-foreground" />
            </span>
            <span className="min-w-0 truncate">
              <strong className="block truncate">{asset.name}</strong>
              <small className="mt-1 block truncate text-xs text-muted-foreground">
                {shortPath(asset.path)}
              </small>
            </span>
            <em className="not-italic text-xs text-muted-foreground">
              {tr(`status.asset.${asset.kind}`)}
            </em>
          </div>
        ))}
        {!visibleAssets.length && <EmptyAssetState hasAssets={homeAssets.length > 0} />}
      </div>
    </div>
  );
}

function EmptyAssetState({ hasAssets }: { hasAssets: boolean }) {
  const { tr } = useI18n();
  return (
    <div className="grid min-h-[120px] place-content-center justify-items-center gap-2 rounded-xl border border-dashed border-border p-4 text-center text-muted-foreground">
      <FileCode2 size={28} />
      <h3 className="m-0 text-sm font-medium">
        {tr(hasAssets ? "catalog.noMatch" : "agents.noHomeAssets")}
      </h3>
    </div>
  );
}

function shortPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}
