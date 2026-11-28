import { useEffect, useId, useRef, useState } from "react";
import type {
  NotificationCategory,
  NotificationPolicy,
  NotificationPolicyPatch,
} from "@agentkib/runtime-protocol";
import type { WebClient } from "@agentkib/web-client";
import { LoadingSkeleton, subscribeSessionForegroundRefresh } from "@agentkib/session-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  createDesktopConversationClient,
  hasDesktopConversation,
} from "@/core/conversation-bridge";
import { useI18n } from "@/core/useI18n";
import {
  SettingsCopy,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
} from "./components/SettingsLayout";

const categories: readonly NotificationCategory[] = ["approval", "question", "completed", "failed"];
const defaultHours = { start: "22:00", end: "08:00" };

type ReadState =
  | { kind: "ready"; policy: NotificationPolicy; editable: boolean }
  | { kind: "unavailable" | "failed" };

export function NotificationPolicySettings() {
  const { tr } = useI18n();
  if (!hasDesktopConversation()) return null;
  return (
    <SettingsSection title={tr("settings.notifications.title")}>
      <NotificationPolicyPanel />
    </SettingsSection>
  );
}

function NotificationPolicyPanel() {
  const { tr } = useI18n();
  const [client] = useState(createDesktopConversationClient);
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState<ReadState>();
  const refresh = () => {
    setRead(undefined);
    setRevision((previous) => previous + 1);
  };
  useEffect(() => {
    let current = true;
    async function load(): Promise<ReadState> {
      const access = await client.access();
      if (access.status !== "approved" || access.pushPolicyVersion !== 1)
        return { kind: "unavailable" };
      const { policy } = await client.notificationPolicy();
      return {
        kind: "ready",
        policy,
        editable: access.device?.accessMode === "full" && access.device.settings === true,
      };
    }
    void load().then(
      (result) => {
        if (current) setRead(result);
      },
      () => {
        if (current) setRead({ kind: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [client, revision]);
  if (read?.kind === "ready")
    return (
      <NotificationPolicyEditor client={client} policy={read.policy} editable={read.editable} />
    );
  if (read?.kind === "failed")
    return (
      <SettingsNotice tone="error" role="alert" className="items-center justify-between">
        {tr("settings.notifications.readFailed")}
        <Button variant="outline" size="sm" onClick={refresh}>
          {tr("sessions.retry")}
        </Button>
      </SettingsNotice>
    );
  return (
    <div className="min-h-48">
      {read?.kind === "unavailable" ? (
        <SettingsNotice role="status">{tr("settings.notifications.unavailable")}</SettingsNotice>
      ) : (
        <LoadingSkeleton label={tr("common.loading")} rows={7} className="px-5 py-3" />
      )}
    </div>
  );
}

function applyOptimisticPatch(
  current: NotificationPolicy,
  patch: NotificationPolicyPatch,
): NotificationPolicy {
  return {
    ...current,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.onlyAway !== undefined ? { onlyAway: patch.onlyAway } : {}),
    ...(patch.categories ? { categories: { ...current.categories, ...patch.categories } } : {}),
    ...(patch.quietHours !== undefined ? { quietHours: patch.quietHours } : {}),
  };
}

function isValidQuietHours(hours: { start: string; end: string }): boolean {
  return Boolean(hours.start && hours.end && hours.start !== hours.end);
}

function NotificationPolicyEditor({
  client,
  policy: initialPolicy,
  editable,
}: {
  client: WebClient;
  policy: NotificationPolicy;
  editable: boolean;
}) {
  const { tr } = useI18n();
  const [policy, setPolicy] = useState(initialPolicy);
  const [hoursDraft, setHoursDraft] = useState<{ start: string; end: string } | null>(
    initialPolicy.quietHours,
  );
  const [writeFailed, setWriteFailed] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const confirmedRef = useRef(initialPolicy);
  const pendingRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const startId = useId();
  const endId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const invalidHours = hoursDraft !== null && !isValidQuietHours(hoursDraft);
  const hasInvalidHoursRef = useRef(invalidHours);
  hasInvalidHoursRef.current = invalidHours;

  useEffect(() => {
    let active = true;
    let reading = false;
    const stop = subscribeSessionForegroundRefresh(() => {
      if (reading || pendingRef.current > 0 || hasInvalidHoursRef.current) return;
      reading = true;
      void client
        .notificationPolicy()
        .then(
          ({ policy: latest }) => {
            if (!active || pendingRef.current > 0 || hasInvalidHoursRef.current) return;
            confirmedRef.current = latest;
            setPolicy(latest);
            setHoursDraft(latest.quietHours);
          },
          () => undefined,
        )
        .finally(() => {
          reading = false;
        });
    });
    return () => {
      active = false;
      stop();
    };
  }, [client]);

  const commitPatch = (patch: NotificationPolicyPatch) => {
    if (!editable) return;
    setWriteFailed(false);
    setPolicy((current) => applyOptimisticPatch(current, patch));
    if (patch.quietHours !== undefined) setHoursDraft(patch.quietHours);
    pendingRef.current += 1;
    setPendingCount(pendingRef.current);

    queueRef.current = queueRef.current
      .then(async () => {
        try {
          const { policy: updated } = await client.updateNotificationPolicy(patch);
          confirmedRef.current = updated;
          if (!mountedRef.current) return;
          if (pendingRef.current === 1) {
            setPolicy(updated);
            if (!hasInvalidHoursRef.current) setHoursDraft(updated.quietHours);
          }
        } catch {
          if (!mountedRef.current) return;
          setWriteFailed(true);
          if (pendingRef.current === 1) {
            setPolicy(confirmedRef.current);
            setHoursDraft(confirmedRef.current.quietHours);
          }
        } finally {
          pendingRef.current -= 1;
          if (mountedRef.current) setPendingCount(pendingRef.current);
        }
      })
      .catch(() => undefined);
  };

  const changeQuietTime = (field: "start" | "end", value: string) => {
    if (!editable || !hoursDraft) return;
    const next = { ...hoursDraft, [field]: value };
    setHoursDraft(next);
    setWriteFailed(false);
    if (isValidQuietHours(next)) {
      commitPatch({ quietHours: next });
    }
  };

  const disabled = !editable;
  const subordinateDisabled = disabled || !policy.enabled;

  return (
    <div aria-busy={pendingCount > 0}>
      {!editable && (
        <SettingsNotice role="status">{tr("settings.notifications.readOnly")}</SettingsNotice>
      )}
      <NotificationSwitch
        label={tr("settings.notifications.enabled")}
        checked={policy.enabled}
        disabled={disabled}
        onChange={(enabled) => commitPatch({ enabled })}
      />
      {categories.map((category) => (
        <NotificationSwitch
          key={category}
          label={tr(`settings.notifications.${category}`)}
          checked={policy.categories[category]}
          disabled={subordinateDisabled}
          onChange={(checked) => commitPatch({ categories: { [category]: checked } })}
        />
      ))}
      <NotificationSwitch
        label={tr("settings.notifications.onlyAway")}
        hint={tr("settings.notifications.onlyAwayHint")}
        checked={policy.onlyAway}
        disabled={subordinateDisabled}
        onChange={(onlyAway) => commitPatch({ onlyAway })}
      />
      <NotificationSwitch
        label={tr("settings.notifications.quietHours")}
        hint={tr("settings.notifications.quietHoursHint")}
        checked={hoursDraft !== null}
        disabled={subordinateDisabled}
        onChange={(checked) =>
          commitPatch({
            quietHours: checked ? (confirmedRef.current.quietHours ?? defaultHours) : null,
          })
        }
      />
      {hoursDraft && (
        <SettingsRow>
          <Label htmlFor={startId}>{tr("settings.notifications.quietInterval")}</Label>
          <div className="flex min-w-0 items-center gap-2">
            <Input
              id={startId}
              type="time"
              value={hoursDraft.start}
              disabled={subordinateDisabled}
              aria-label={tr("settings.notifications.start")}
              onChange={(event) => changeQuietTime("start", event.target.value)}
            />
            <span aria-hidden>–</span>
            <Input
              id={endId}
              type="time"
              value={hoursDraft.end}
              disabled={subordinateDisabled}
              aria-label={tr("settings.notifications.end")}
              onChange={(event) => changeQuietTime("end", event.target.value)}
            />
          </div>
        </SettingsRow>
      )}
      {invalidHours && (
        <SettingsNotice tone="warning" role="status">
          {tr("settings.notifications.invalidHours")}
        </SettingsNotice>
      )}
      {writeFailed && (
        <SettingsNotice tone="error" role="alert">
          {tr("settings.notifications.writeFailed")}
        </SettingsNotice>
      )}
    </div>
  );
}

function NotificationSwitch({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const labelId = useId();
  const hintId = useId();
  return (
    <SettingsRow>
      <SettingsCopy>
        <strong id={labelId}>{label}</strong>
        {hint && <small id={hintId}>{hint}</small>}
      </SettingsCopy>
      <Switch
        aria-labelledby={labelId}
        aria-describedby={hint ? hintId : undefined}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </SettingsRow>
  );
}
