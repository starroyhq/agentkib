import type { RefObject } from "react";
import type { SessionAction, SessionActionBody } from "@agentkib/web-client";
import type { PendingComposerSettings } from "./composer-session-settings";
import { composerFollowerSettingsRequest } from "./session-composer-capabilities";

export type ComposerMutationFields = Omit<
  Partial<SessionActionBody>,
  "requestId" | "bootId" | "sessionId" | "expectedRevision" | "expectedSettingsScope"
>;

/** Submit once, then refresh the same visit only after the action controller has verified its receipt. */
export async function runComposerSettingsMutation({
  action,
  fields,
  permitted,
  settingsAllowed,
  readRevision,
  liveRevision,
  follower,
  flight,
  loadGeneration,
  send,
  onStart,
  onAccepted,
  onPendingSettings,
  onGoalChanged,
  refresh,
  onError,
  onSettle,
}: {
  action: SessionAction;
  fields: ComposerMutationFields;
  permitted: boolean;
  settingsAllowed: boolean;
  readRevision?: number;
  liveRevision?: number;
  follower?: { authority: object; writeScope?: string };
  flight: RefObject<symbol | undefined>;
  loadGeneration: RefObject<number>;
  send: (action: SessionAction, fields: Partial<SessionActionBody>) => Promise<unknown>;
  onStart: () => void;
  onAccepted: () => void;
  onPendingSettings: (value: PendingComposerSettings) => void;
  onGoalChanged: () => void;
  refresh: () => Promise<unknown>;
  onError: (error: unknown) => void;
  onSettle: () => void;
}) {
  const changesSettings = action === "settings";
  if (!permitted || flight.current || (changesSettings && !settingsAllowed)) return false;
  if (liveRevision !== undefined && readRevision !== liveRevision) return false;
  const request =
    changesSettings && follower
      ? composerFollowerSettingsRequest(fields, follower.writeScope)
      : fields;
  if (!request) return false;

  const generation = loadGeneration.current;
  const owner = Symbol("composer-settings-mutation");
  flight.current = owner;
  onStart();
  try {
    const result = await send(action, request);
    if (!result || flight.current !== owner) return false;
    onAccepted();
    if (generation !== loadGeneration.current) return !changesSettings;
    if (changesSettings) {
      onPendingSettings({
        ...fields,
        expectedRevision: readRevision ?? 0,
        followerAuthority: follower?.authority,
        nextTurn:
          typeof result === "object" && "appliesTo" in result && result.appliesTo === "next-turn",
      });
    }
    if (action.startsWith("goal-")) onGoalChanged();
    await refresh();
    return true;
  } catch (error) {
    if (flight.current === owner && generation === loadGeneration.current) onError(error);
    return false;
  } finally {
    if (flight.current === owner) {
      flight.current = undefined;
      onSettle();
    }
  }
}
