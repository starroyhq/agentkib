import { retryBusyRead } from "./session-read-retry";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  isLiveSessionAgent,
  type Access,
  type SessionCapabilities,
  type Live,
  type WebClient,
} from "@agentkib/web-client";

export function capabilityAccessBinding(access: Access | undefined) {
  return JSON.stringify([
    access?.status,
    access?.bootId,
    access?.protocolVersion,
    access?.experimentalEnabled,
    access?.device?.id,
    access?.device?.accessMode,
    access?.device?.send,
    access?.device?.approve,
    access?.device?.manage,
    access?.device?.files,
    access?.device?.attachments,
    access?.device?.advancedControl,
    access?.device?.organize,
    access?.device?.settings,
    access?.device?.extendedApproval,
  ]);
}

/** Retained presentation never substitutes for the current read before a control. */
export function useSessionCapabilities({
  client,
  selected,
  agent,
  access,
  live,
  epoch,
}: {
  client: WebClient;
  selected: string;
  agent: string | undefined;
  access: Access | undefined;
  live: Live | undefined;
  epoch: number;
}) {
  const identity =
    selected && access?.status === "approved" && isLiveSessionAgent(agent)
      ? JSON.stringify([
          selected,
          agent,
          capabilityAccessBinding(access),
          live?.executionMode,
          live?.connectionGeneration,
        ])
      : "";
  const [visit, setVisit] = useState({ identity, client, version: 0 });
  const currentVisit =
    visit.identity === identity && visit.client === client
      ? visit
      : { identity, client, version: visit.version + 1 };
  if (currentVisit !== visit) setVisit(currentVisit);
  const binding = identity ? JSON.stringify([identity, currentVisit.version]) : "";
  const mode = live?.sessionId === selected ? live.executionMode : undefined;
  const key = JSON.stringify([
    binding,
    epoch,
    live?.status,
    live?.reason,
    live?.sendEnabled,
    live?.stopEnabled,
    live?.approvals.some((item) => item.supported),
    live?.questions?.some((item) => item.supported),
  ]);
  const scope = useRef({ binding, key });
  useLayoutEffect(() => {
    scope.current = { binding, key };
  }, [binding, key]);
  const [snapshot, setSnapshot] = useState<{ binding: string; value: SessionCapabilities }>();
  const request = useRef<
    | { key: string; abort: AbortController; promise: Promise<SessionCapabilities | undefined> }
    | undefined
  >(undefined);
  const verifyCapabilities = useCallback(() => {
    if (scope.current.key !== key || !binding || !isLiveSessionAgent(agent))
      return Promise.resolve(undefined);
    if (request.current?.key === key && !request.current.abort.signal.aborted)
      return request.current.promise;
    request.current?.abort.abort();
    const abort = new AbortController();
    const promise = retryBusyRead(
      () => client.sessionCapabilities(selected, agent, abort.signal),
      abort.signal,
    )
      .then(
        (value) => {
          if (abort.signal.aborted || scope.current.key !== key) return;
          if (
            value.sessionId !== selected ||
            !value.features ||
            (mode && value.executionMode && mode !== value.executionMode)
          ) {
            setSnapshot(undefined);
            return;
          }
          setSnapshot({ binding, value });
          return value;
        },
        () => {
          if (!abort.signal.aborted && scope.current.key === key) setSnapshot(undefined);
          return undefined;
        },
      )
      .finally(() => {
        // Share only an in-flight read. An older aborted read can settle after
        // a replacement with the same key, so release only this physical read.
        if (request.current?.abort === abort) request.current = undefined;
      });
    request.current = { key, abort, promise };
    return promise;
  }, [agent, binding, client, key, mode, selected]);
  useEffect(() => {
    void verifyCapabilities();
    return () => {
      if (request.current?.key === key) request.current.abort.abort();
    };
  }, [key, verifyCapabilities]);
  const clearCapabilities = useCallback(() => {
    request.current?.abort.abort();
    request.current = undefined;
    setSnapshot(undefined);
  }, []);
  return {
    capabilityScope: binding,
    capabilities: snapshot?.binding === binding ? snapshot.value : undefined,
    verifyCapabilities,
    clearCapabilities,
  };
}
