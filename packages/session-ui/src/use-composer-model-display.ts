import { useEffect, useRef } from "react";
import {
  forgetSessionModelDisplay,
  readSessionModelDisplay,
  rememberSessionModelDisplay,
  sessionModelDisplayFallback,
  type Access,
  type CodexSessionSettings,
  type SessionModelDisplay,
  type SessionProviderCapabilities,
  type WebClient,
} from "@agentkib/web-client";

/** A displayed model is scoped evidence, with no permission to use it as a write selection. */
export function useComposerModelDisplay({
  client,
  access,
  sessionId,
  agent,
  denied,
  settingsReadable,
  reservesSlot,
  provider,
  catalog,
  observed,
  historical,
  defaults,
  holdCache,
  uncertain = false,
}: {
  client: WebClient;
  access?: Access;
  sessionId: string;
  agent?: string;
  denied: boolean;
  settingsReadable: boolean;
  reservesSlot: boolean;
  provider?: SessionProviderCapabilities;
  catalog?: CodexSessionSettings;
  observed?: Partial<SessionModelDisplay>;
  historical?: Partial<SessionModelDisplay>;
  defaults?: Partial<SessionModelDisplay>;
  holdCache: boolean;
  uncertain?: boolean;
}) {
  function findOption(model: string | undefined) {
    if (!model) return undefined;
    const models = catalog?.sessionId === sessionId ? catalog.options.models : undefined;
    return (
      models?.find((item) => item.id === model || item.resolvedModel === model) ??
      models?.find((item) => item.variants?.some((variant) => variant.id === model))
    );
  }

  const allowed =
    !denied &&
    access?.status === "approved" &&
    access.device?.accessMode === "full" &&
    access.device.advancedControl === true;
  const authorizedDisplay = useRef<
    | {
        client: WebClient;
        access: Access;
        sessionId: string;
        agent?: string;
      }
    | undefined
  >(undefined);
  useEffect(() => {
    const previous = authorizedDisplay.current;
    if (allowed) authorizedDisplay.current = { client, access, sessionId, agent };
    else {
      if (denied) forgetSessionModelDisplay(client, access, sessionId, agent);
      if (previous?.client === client && previous.sessionId === sessionId)
        forgetSessionModelDisplay(client, previous.access, sessionId, previous.agent);
      authorizedDisplay.current = undefined;
    }
  }, [access, agent, allowed, client, denied, sessionId]);
  const cached = allowed ? readSessionModelDisplay(client, access, sessionId, agent) : undefined;
  const preservesCache = holdCache && !!cached;
  const id = observed?.modelId;
  const option = findOption(id);
  const name = observed?.name ?? option?.name;
  const effort = observed?.effort;
  const tier = observed?.serviceTierId;
  useEffect(() => {
    if (!id || uncertain || !allowed || preservesCache) return;
    rememberSessionModelDisplay(client, access, sessionId, agent, {
      modelId: id,
      name,
      effort,
      serviceTierId: tier,
      ...(option &&
        catalog?.available && {
          effortOptions: {
            id: option.id,
            resolvedModel: option.resolvedModel,
            efforts: option.efforts,
            defaultEffort: option.defaultEffort,
            variants: option.variants,
          },
        }),
    });
  }, [
    access,
    agent,
    allowed,
    catalog?.available,
    client,
    effort,
    preservesCache,
    id,
    name,
    option,
    sessionId,
    tier,
    uncertain,
  ]);

  const historicalDisplay = historical?.modelId
    ? { ...historical, name: historical.name ?? findOption(historical.modelId)?.name }
    : undefined;
  const modelVisible =
    !provider ||
    provider.models.prepare ||
    !catalog?.available ||
    catalog.options.models.length > 0 ||
    !!id ||
    !!cached;
  return {
    displayFallback: sessionModelDisplayFallback(historicalDisplay, cached, defaults, holdCache),
    retainedEffortOptions: cached?.effortOptions,
    showModelPicker: !denied && (reservesSlot || ((settingsReadable || !!cached) && modelVisible)),
  };
}
