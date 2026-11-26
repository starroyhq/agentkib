import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type {
  NotificationCategory,
  NotificationPolicy,
  NotificationPolicyPatch,
} from "@agentkib/runtime-protocol";
import type { WebClient } from "@agentkib/web-client";
import {
  DelayedSpinner,
  LoadingSkeleton,
  subscribeSessionForegroundRefresh,
} from "@agentkib/session-ui";
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

const categories = ["approval", "question", "completed", "failed"] as const;
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
        <SettingsNotice role="status" className="items-center justify-between">
          {tr("settings.notifications.unavailable")}
          <Button variant="outline" size="sm" disabled>
            {tr("common.save")}
          </Button>
        </SettingsNotice>
      ) : (
        <LoadingSkeleton label={tr("common.loading")} rows={7} className="px-5 py-3" />
      )}
    </div>
  );
}

function changes(before: NotificationPolicy, after: NotificationPolicy): NotificationPolicyPatch {
  const patch: NotificationPolicyPatch = {};
  if (before.enabled !== after.enabled) patch.enabled = after.enabled;
  if (before.onlyAway !== after.onlyAway) patch.onlyAway = after.onlyAway;
  const updatedCategories: Partial<Record<NotificationCategory, boolean>> = {};
  for (const category of categories)
    if (before.categories[category] !== after.categories[category])
      updatedCategories[category] = after.categories[category];
  if (Object.keys(updatedCategories).length) patch.categories = updatedCategories;
  if (
    before.quietHours?.start !== after.quietHours?.start ||
    before.quietHours?.end !== after.quietHours?.end
  )
    patch.quietHours = after.quietHours;
  return patch;
}

function NotificationPolicyEditor({
  client,
  policy,
  editable,
}: {
  client: WebClient;
  policy: NotificationPolicy;
  editable: boolean;
}) {
  const { tr } = useI18n();
  const [saved, setSaved] = useState(policy);
  const [draft, setDraft] = useState(policy);
  const [state, setState] = useState<"saving" | "failed">();
  const saving = useRef(false);
  const startId = useId();
  const endId = useId();
  const patch = changes(saved, draft);
  const changed = Object.keys(patch).length > 0;
  const quietHours = draft.quietHours;
  const invalidHours =
    quietHours !== null &&
    (!quietHours.start || !quietHours.end || quietHours.start === quietHours.end);
  const disabled = !editable || state === "saving";
  const subordinateDisabled = disabled || !draft.enabled;
  useEffect(() => {
    if (changed) return;
    let active = true;
    let reading = false;
    const stop = subscribeSessionForegroundRefresh(() => {
      if (reading || saving.current) return;
      reading = true;
      void client
        .notificationPolicy()
        .then(
          ({ policy }) => {
            if (!active || saving.current) return;
            setSaved(policy);
            setDraft((current) => (current === draft ? policy : current));
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
  }, [changed, client, draft]);

  const edit = (change: Partial<NotificationPolicy>) => {
    setDraft((current) => ({ ...current, ...change }));
    setState(undefined);
  };
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !changed || invalidHours || saving.current) return;
    saving.current = true;
    setState("saving");
    try {
      const { policy: updated } = await client.updateNotificationPolicy(patch);
      setSaved(updated);
      setDraft(updated);
      setState(undefined);
    } catch {
      setState("failed");
    } finally {
      saving.current = false;
    }
  }

  return (
    <form onSubmit={save} aria-busy={state === "saving"}>
      {!editable && (
        <SettingsNotice role="status">{tr("settings.notifications.readOnly")}</SettingsNotice>
      )}
      <NotificationSwitch
        label={tr("settings.notifications.enabled")}
        checked={draft.enabled}
        disabled={disabled}
        onChange={(enabled) => edit({ enabled })}
      />
      {categories.map((category) => (
        <NotificationSwitch
          key={category}
          label={tr(`settings.notifications.${category}`)}
          checked={draft.categories[category]}
          disabled={subordinateDisabled}
          onChange={(checked) => edit({ categories: { ...draft.categories, [category]: checked } })}
        />
      ))}
      <NotificationSwitch
        label={tr("settings.notifications.onlyAway")}
        hint={tr("settings.notifications.onlyAwayHint")}
        checked={draft.onlyAway}
        disabled={subordinateDisabled}
        onChange={(onlyAway) => edit({ onlyAway })}
      />
      <NotificationSwitch
        label={tr("settings.notifications.quietHours")}
        hint={tr("settings.notifications.quietHoursHint")}
        checked={quietHours !== null}
        disabled={subordinateDisabled}
        onChange={(checked) =>
          edit({ quietHours: checked ? (saved.quietHours ?? defaultHours) : null })
        }
      />
      {quietHours && (
        <SettingsRow>
          <Label htmlFor={startId}>{tr("settings.notifications.quietInterval")}</Label>
          <div className="flex min-w-0 items-center gap-2">
            <Input
              id={startId}
              type="time"
              value={quietHours.start}
              disabled={subordinateDisabled}
              aria-label={tr("settings.notifications.start")}
              onChange={(event) =>
                edit({ quietHours: { ...quietHours, start: event.target.value } })
              }
            />
            <span aria-hidden>–</span>
            <Input
              id={endId}
              type="time"
              value={quietHours.end}
              disabled={subordinateDisabled}
              aria-label={tr("settings.notifications.end")}
              onChange={(event) => edit({ quietHours: { ...quietHours, end: event.target.value } })}
            />
          </div>
        </SettingsRow>
      )}
      {invalidHours && (
        <SettingsNotice tone="warning" role="status">
          {tr("settings.notifications.invalidHours")}
        </SettingsNotice>
      )}
      {state === "failed" && (
        <SettingsNotice tone="error" role="alert">
          {tr("settings.notifications.writeFailed")}
        </SettingsNotice>
      )}
      <div className="flex min-h-16 flex-wrap items-center justify-end gap-3 px-5 py-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={state === "saving" || !changed}
          onClick={() => {
            setDraft(saved);
            setState(undefined);
          }}
        >
          {tr("common.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={disabled || !changed || invalidHours}>
          <span className="size-3.5">
            <DelayedSpinner active={state === "saving"} />
          </span>
          {tr("common.save")}
        </Button>
      </div>
    </form>
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
