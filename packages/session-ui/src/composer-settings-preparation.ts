import type { RefObject } from "react";
import type { Access, CodexSessionSettings, WebClient } from "@agentkib/web-client";

type PreparationAuthority = {
  selected: string;
  client: Pick<WebClient, "prepareSessionSettings">;
  bootId?: string;
  deviceId?: string;
  full: boolean;
  advancedControl?: boolean;
  accessStatus?: Access["status"];
  execution: string;
  allowed: boolean;
};

/** A catalog read can refresh options without replacing settings from a newer observation. */
export function mergePreparedCatalog(
  current: CodexSessionSettings,
  prepared: CodexSessionSettings,
): CodexSessionSettings {
  return {
    ...current,
    provider: prepared.provider ?? current.provider,
    defaults: { ...prepared.defaults, ...current.defaults },
    options: { ...current.options, models: prepared.options.models },
    writable: {
      ...current.writable,
      model: prepared.writable.model,
      effort: prepared.writable.effort,
    },
  };
}

export function prepareComposerSettings({
  currentAuthority,
  flight,
  loadGeneration,
  readVersion,
  revision,
  onStart,
  onPrepared,
  onError,
  onSettle,
}: {
  currentAuthority: RefObject<PreparationAuthority>;
  flight: RefObject<symbol | undefined>;
  loadGeneration: RefObject<number>;
  readVersion: RefObject<number>;
  revision?: number;
  onStart: () => void;
  onPrepared: (value: CodexSessionSettings, currentRead: boolean) => void;
  onError: (error: unknown) => void;
  onSettle: () => void;
}) {
  const authority = currentAuthority.current;
  if (!authority.allowed || !authority.selected || !authority.bootId || revision === undefined)
    return false;
  if (flight.current) return true;

  const generation = loadGeneration.current;
  const preparation = Symbol("settings-prepare");
  readVersion.current++;
  flight.current = preparation;
  onStart();
  function sameAuthority() {
    const now = currentAuthority.current;
    return (
      flight.current === preparation &&
      now.allowed &&
      authority.selected === now.selected &&
      authority.client === now.client &&
      authority.bootId === now.bootId &&
      authority.deviceId === now.deviceId &&
      authority.full === now.full &&
      authority.advancedControl === now.advancedControl &&
      authority.accessStatus === now.accessStatus &&
      authority.execution === now.execution
    );
  }
  void authority.client
    .prepareSessionSettings({
      sessionId: authority.selected,
      bootId: authority.bootId,
      expectedRevision: revision,
    })
    .then((value) => {
      if (!sameAuthority() || value.sessionId !== authority.selected) return;
      readVersion.current++;
      onPrepared(value, generation === loadGeneration.current);
    })
    .catch((error: unknown) => {
      if (sameAuthority() && generation === loadGeneration.current) onError(error);
    })
    .finally(() => {
      // An observation can invalidate the read without changing who owns its busy state.
      if (flight.current === preparation) {
        flight.current = undefined;
        onSettle();
      }
    });
  return true;
}
