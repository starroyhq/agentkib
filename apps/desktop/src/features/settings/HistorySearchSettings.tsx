import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { HistorySearchStatus } from "@agentkib/web-client";
import { agentName } from "@agentkib/agent-identity";
import { HistoryCoverageStatus, historyCopy } from "@agentkib/session-ui";
import {
  createDesktopConversationClient,
  hasDesktopConversation,
} from "@/core/conversation-bridge";
import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import { SettingsSection, SettingsNotice } from "./components/SettingsLayout";

type IndexOperation = "toggle" | "clear" | "rebuild";

export function HistorySearchSettings() {
  const { locale } = useI18n();
  const c = historyCopy[locale];
  const [client] = useState(createDesktopConversationClient);
  const [status, setStatus] = useState<HistorySearchStatus>();
  const [supported, setSupported] = useState(false);
  const [activeOperation, setActiveOperation] = useState<IndexOperation>();
  const busy = activeOperation !== undefined;
  const [error, setError] = useState(false);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const mutating = useRef(false);
  const reads = useRef(new Set<AbortController>());
  useEffect(() => {
    if (!hasDesktopConversation()) return;
    mounted.current = true;
    const generation = epoch.current;
    const abort = new AbortController();
    const pending = reads.current;
    pending.add(abort);
    void client
      .access(abort.signal)
      .then(async (access) => {
        if (!access.historySearch || abort.signal.aborted || generation !== epoch.current) return;
        setSupported(true);
        const value = await client.historyStatus(abort.signal);
        if (!abort.signal.aborted && generation === epoch.current) setStatus(value);
      })
      .catch(() => {
        if (!abort.signal.aborted && generation === epoch.current) setError(true);
      })
      .finally(() => pending.delete(abort));
    return () => {
      mounted.current = false;
      epoch.current++;
      for (const read of pending) read.abort();
      pending.clear();
    };
  }, [client]);
  useEffect(() => {
    if (!supported || !status?.enabled || busy) return;
    const generation = epoch.current;
    const abort = new AbortController();
    const pending = reads.current;
    pending.add(abort);
    let checking = false;
    const timer = setInterval(() => {
      if (checking || mutating.current || abort.signal.aborted) return;
      checking = true;
      void client
        .historyStatus(abort.signal)
        .then((value) => {
          if (!abort.signal.aborted && generation === epoch.current) setStatus(value);
        })
        .catch(() => {})
        .finally(() => {
          checking = false;
        });
    }, 5000);
    return () => {
      abort.abort();
      pending.delete(abort);
      clearInterval(timer);
    };
  }, [client, supported, status?.enabled, busy]);
  async function run(operation: IndexOperation) {
    if (mutating.current) return;
    mutating.current = true;
    const generation = ++epoch.current;
    for (const read of reads.current) read.abort();
    reads.current.clear();
    setActiveOperation(operation);
    setError(false);
    try {
      const value =
        operation === "toggle"
          ? await client.historyConfigure(!status?.enabled)
          : operation === "clear"
            ? await client.historyClear()
            : await client.historyRebuild();
      if (mounted.current && generation === epoch.current) setStatus(value);
    } catch {
      if (mounted.current && generation === epoch.current) setError(true);
    } finally {
      mutating.current = false;
      if (mounted.current && generation === epoch.current) setActiveOperation(undefined);
    }
  }
  if (!supported) return null;
  const spinner = <LoaderCircle className="motion-safe:animate-spin" aria-hidden />;
  const loadingTitle = busy ? c.loading : undefined;
  return (
    <SettingsSection title={c.settings}>
      <p className="text-sm text-muted-foreground">{c.settingsInfo}</p>
      {status && (
        <>
          <HistoryCoverageStatus status={status} locale={locale} agentName={agentName} />
          <p className="text-xs text-muted-foreground">
            {Math.ceil(status.bytes / 1024)} / {Math.ceil(status.limitBytes / 1024)} KiB
          </p>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || !status}
          title={loadingTitle}
          aria-busy={activeOperation === "toggle" || undefined}
          onClick={() => void run("toggle")}
        >
          {activeOperation === "toggle" && spinner}
          {status?.enabled ? c.disable : c.enable}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          title={loadingTitle}
          aria-busy={activeOperation === "clear" || undefined}
          onClick={() => void run("clear")}
        >
          {activeOperation === "clear" && spinner}
          {c.clear}
        </Button>
        <Button
          variant="outline"
          disabled={busy || !status?.enabled}
          title={loadingTitle}
          aria-busy={activeOperation === "rebuild" || undefined}
          onClick={() => void run("rebuild")}
        >
          {activeOperation === "rebuild" && spinner}
          {c.rebuild}
        </Button>
      </div>
      {error && (
        <SettingsNotice tone="error" role="alert">
          {c.error}
        </SettingsNotice>
      )}
    </SettingsSection>
  );
}
