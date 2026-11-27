import {
  REMOTE_ERROR_CODES as codes,
  sessionProviderDeclaration,
  type ProjectAgentExecutionSide,
  type ProjectAgentRoleReason,
} from "@agentkib/runtime-protocol";
import type { LaneHost } from "../orchestration-service";
import type { WebReadRequests } from "../web-read";
import type { ClaudeBridge } from "./claude/claude-bridge";
import type { ClaudeManagedReadOwner } from "./claude/claude-managed-read";
import type { DevinSessionProvider } from "./devin/session-provider";
import type { DshBridge } from "./dsh/dsh-bridge";

export interface ProviderRoleFacts {
  executionSide: ProjectAgentExecutionSide;
  reason?: ProjectAgentRoleReason;
  toolsReady?: boolean | null;
}

type RoleProviders = {
  session: LaneHost["session"];
  claude?: Pick<
    ClaudeManagedReadOwner,
    "hasManagedSession" | "hasRunningNativeTerminal" | "projectAgentToolsReady"
  >;
  bridge?: () => ClaudeBridge | undefined;
  dsh?: DshBridge;
  web: <T>(read: (owner: WebReadRequests) => T) => Promise<Awaited<T>>;
  antigravityEnabled: boolean;
};

export function projectAgentRoleAdapters(sources: RoleProviders) {
  return async (
    id: string,
    role: "lead" | "worker",
    live?: Record<string, unknown> | null,
  ): Promise<ProviderRoleFacts> => {
    const lead = role === "lead";
    const agent = sources.session(id)?.agent;
    const refused = (reason: ProjectAgentRoleReason): ProviderRoleFacts => ({
      executionSide: null,
      reason,
    });
    if (agent === "antigravity" && !sources.antigravityEnabled)
      return refused(codes.antigravityAcpDisabled);
    if (!sessionProviderDeclaration(agent)?.projectAgent?.[role])
      return refused(lead ? codes.leadNotControllable : codes.workerAgentUnsupported);
    switch (agent) {
      case "claude-code": {
        const bridge = sources.bridge?.();
        const managed = sources.claude;
        if (
          bridge?.handles(id) &&
          (bridge.blocksManagedResume(id) || !managed?.hasManagedSession(id))
        ) {
          const snapshot = live ?? bridge.live(id, true);
          const reason =
            snapshot.status === "outcome-unknown"
              ? codes.controlOutcomeUnconfirmed
              : snapshot.executionLocation !== "terminal"
                ? lead
                  ? codes.leadClaudeTerminalDisconnected
                  : codes.workerTerminalDisconnected
                : lead
                  ? bridge.leadCapable(id)
                    ? undefined
                    : codes.leadToolsUnavailable
                  : snapshot.terminalSend === true && snapshot.status !== "unsupported"
                    ? undefined
                    : codes.workerNotControllable;
          return {
            executionSide: "terminal",
            reason,
            toolsReady: lead ? bridge.leadToolsReady(id) : null,
          };
        }
        if (managed?.hasManagedSession(id))
          return {
            executionSide: "agentkib",
            reason:
              live?.status === "outcome-unknown"
                ? codes.controlOutcomeUnconfirmed
                : live?.status === "unsupported"
                  ? lead
                    ? codes.leadNotControllable
                    : codes.workerNotControllable
                  : undefined,
            toolsReady: managed.projectAgentToolsReady(id),
          };
        if (await managed?.hasRunningNativeTerminal(id, !lead))
          return {
            executionSide: "terminal",
            reason: lead ? codes.leadClaudeTerminalDisconnected : codes.workerTerminalDisconnected,
          };
        return refused(lead ? codes.leadNotControllable : codes.workerNotControllable);
      }
      case "deepseek-harness": {
        const dsh = sources.dsh;
        if (!dsh?.handles(id)) return refused(codes.dshRuntimeOffline);
        const snapshot = live ?? dsh.live(id, true);
        return {
          executionSide: snapshot.executionLocation === "external" ? "external" : "agentkib",
          reason:
            snapshot.status === "outcome-unknown"
              ? codes.controlOutcomeUnconfirmed
              : dsh.projectAgentRoles(id)[role],
          toolsReady: null,
        };
      }
      case "devin": {
        const reason = await sources.web((owner) =>
          (owner.devinSessionProvider() as DevinSessionProvider).projectAgentRefusal(id),
        );
        return { executionSide: "agentkib", reason, toolsReady: null };
      }
      case "codex":
        return sources.web(async (owner) => {
          if (lead) {
            const readiness = await owner.codexLeadReadiness(id);
            return {
              executionSide: readiness?.requiresAdoption ? "external" : "agentkib",
              reason: readiness?.canDesignate
                ? undefined
                : (readiness?.reason ?? codes.leadNotControllable),
              toolsReady: readiness?.requiresAdoption ? false : owner.runnerHasLeadTools(id),
            };
          }
          const managed = owner.codexLeadCapable(id);
          return {
            executionSide:
              live?.executionLocation === "external"
                ? "external"
                : managed
                  ? "agentkib"
                  : "external",
            reason:
              live?.status === "outcome-unknown" ? codes.controlOutcomeUnconfirmed : undefined,
            toolsReady: managed ? owner.runnerHasLeadTools(id) : false,
          };
        });
      case "antigravity":
        return sources.web(async (owner) => ({
          executionSide: "agentkib",
          reason: (
            lead ? owner.antigravityLeadCapable(id) : await owner.antigravityWorkerAvailable(id)
          )
            ? undefined
            : lead
              ? codes.leadNotControllable
              : codes.workerNotControllable,
        }));
      default:
        return refused(lead ? codes.leadNotControllable : codes.workerAgentUnsupported);
    }
  };
}
