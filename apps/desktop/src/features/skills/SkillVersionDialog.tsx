import { useQuery } from "@tanstack/react-query";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";
import { skillKeys } from "./skills-query";
import { useEffect, useRef, useState } from "react";
import { DelayedSpinner, LoadingSkeleton } from "@agentkib/session-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/core/api";
import type { SkillOperationPreview, SkillSource } from "@/core/types";
import { useI18n } from "@/core/useI18n";

type VersionType = "tag" | "branch" | "commit";

export function SkillVersionDialog({
  name,
  source,
  libraryId,
  onClose,
  onPrepared,
}: {
  name: string;
  source: SkillSource;
  libraryId?: string;
  onClose: () => void;
  onPrepared: (preview: SkillOperationPreview) => void;
}) {
  const { tr, localizeMessage } = useI18n();
  const [type, setType] = useState<VersionType>(source.ref_type ?? "tag");
  const [value, setValue] = useState(source.ref_type === "commit" ? source.resolved_commit : "");
  const [page, setPage] = useState(1);

  const queryClient = useOptionalQueryClient();
  const versionRequest = {
    ...(libraryId ? { library_id: libraryId } : { source }),
    type: type === "commit" ? ("tag" as const) : type,
    page,
  };
  const versionsQuery = useQuery(
    {
      ...queryDefaults,
      queryKey: skillKeys.versions(versionRequest),
      queryFn: () => api.listSkillVersions(versionRequest),
      enabled: type !== "commit",
      staleTime: 0,
      gcTime: 0,
    },
    queryClient,
  );
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<unknown>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = { list: versionsQuery.data, error: versionsQuery.error };
  const loading = type !== "commit" && versionsQuery.isPending;
  const valid = type === "commit" ? /^[0-9a-f]{7,40}$/i.test(value.trim()) : Boolean(value);
  const prepare = async () => {
    if (!valid || preparing || loading) return;
    setPreparing(true);
    setError(undefined);
    try {
      const selector = { type, value: value.trim() };
      const preview = libraryId
        ? await api.prepareSkillVersionChange(libraryId, selector)
        : await api.prepareSkillInstall({
            ...source,
            ref: selector.value,
            ref_type: selector.type,
          });
      if (!mounted.current) {
        await api.discardSkillPreview(preview.token);
        return;
      }
      onPrepared(preview);
    } catch (nextError) {
      if (mounted.current) setError(nextError);
    }
    if (mounted.current) setPreparing(false);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !preparing && onClose()}>
      <DialogContent showCloseButton={!preparing} className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tr("skills.versions.title", { name })}</DialogTitle>
          <DialogDescription>{tr("skills.versions.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1 rounded-lg border p-3 text-sm">
          <span>{tr("skills.versions.current")}</span>
          <code className="break-all">
            {source.ref} · {source.resolved_commit.slice(0, 12)}
          </code>
          <span className="break-all text-xs text-muted-foreground">
            {source.repository}/{source.path}
          </span>
        </div>
        <Tabs
          value={type}
          onValueChange={(next) => {
            if (preparing) return;
            setType(next as VersionType);
            setPage(1);
            setValue(next === "commit" ? source.resolved_commit : "");
            setError(undefined);
          }}
        >
          <TabsList>
            {(["tag", "branch", "commit"] as const).map((entry) => (
              <TabsTrigger key={entry} value={entry} disabled={preparing}>
                {tr(`skills.versions.${entry}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {type === "commit" ? (
          <div className="grid gap-2">
            <Input
              aria-label={tr("skills.versions.commitInput")}
              value={value}
              disabled={preparing}
              onChange={(event) => setValue(event.target.value)}
              placeholder={tr("skills.versions.commitInput")}
            />
            <p className="text-xs text-muted-foreground">{tr("skills.versions.commitHint")}</p>
          </div>
        ) : loading ? (
          <LoadingSkeleton label={tr("common.loading")} />
        ) : current?.error ? (
          <div role="alert" className="grid gap-2 text-sm text-destructive-text">
            <p>{localizeMessage(current.error)}</p>
            <Button
              variant="outline"
              onClick={() => void versionsQuery.refetch({ cancelRefetch: false })}
            >
              {tr("skills.versions.retry")}
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            <div
              role="group"
              aria-label={tr(`skills.versions.${type}`)}
              className="grid max-h-64 gap-2 overflow-y-auto"
            >
              {!current?.list?.entries.length && (
                <p className="text-sm text-muted-foreground">{tr("skills.versions.empty")}</p>
              )}
              {current?.list?.entries.map((entry) => (
                <Button
                  key={entry.name}
                  variant={value === entry.name ? "secondary" : "outline"}
                  aria-pressed={value === entry.name}
                  disabled={preparing}
                  onClick={() => setValue(entry.name)}
                  className="h-auto justify-between gap-2 p-2 text-left text-sm"
                >
                  <span className="min-w-0 flex-1 break-all">{entry.name}</span>
                  <code className="text-xs text-muted-foreground">{entry.commit.slice(0, 12)}</code>
                </Button>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 1 || preparing}
                onClick={() => {
                  setValue("");
                  setPage((page) => page - 1);
                }}
              >
                {tr("skills.versions.previousPage")}
              </Button>
              <span className="text-xs">{tr("skills.versions.page", { page })}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={!current?.list?.has_more || preparing}
                onClick={() => {
                  setValue("");
                  setPage((page) => page + 1);
                }}
              >
                {tr("skills.versions.nextPage")}
              </Button>
            </div>
          </div>
        )}
        {error !== undefined && (
          <p role="alert" className="text-sm text-destructive-text">
            {localizeMessage(error)}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{tr("skills.versions.deploymentNotice")}</p>
        <DialogFooter>
          <Button variant="outline" disabled={preparing} onClick={onClose}>
            {tr("common.cancel")}
          </Button>
          <Button disabled={!valid || loading || preparing} onClick={() => void prepare()}>
            <span aria-hidden className="size-3.5">
              <DelayedSpinner active={preparing} />
            </span>
            {tr("skills.versions.review")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
