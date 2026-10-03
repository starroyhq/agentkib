import type { IpcMainInvokeEvent } from "electron";
import { app, shell } from "electron";
import path from "node:path";
import { RUNTIME_METHODS } from "../../generated/runtime-protocol";
import type { RuntimeHost } from "../runtime-host";
import { createIpcRegistrar } from "./registrar";
import { verifiedCursorBridgeBundle } from "../cursor-bridge-bundle";
import {
  optionalPositiveInteger,
  optionalString,
  requireAgentKind,
  requireBoolean,
  requireObject,
  requirePositiveInteger,
  requireString,
  requireText,
} from "./validation";

interface RuntimeIpcOptions {
  runtime(): RuntimeHost;
  assertTrustedRenderer(event: IpcMainInvokeEvent): void;
  withRuntimeCapabilities(runtime: unknown): unknown;
}

export function registerRuntimeIpc({
  runtime,
  assertTrustedRenderer,
  withRuntimeCapabilities: withElectronRuntimeCapabilities,
}: RuntimeIpcOptions): void {
  const { handle, forward } = createIpcRegistrar({ assertTrustedRenderer, runtime });

  function registerWorkspaceIpc(): void {
    const bridgeBundle = () =>
      verifiedCursorBridgeBundle(
        app.isPackaged
          ? path.join(process.resourcesPath, "cursor-bridge")
          : path.join(app.getAppPath(), "build", "cursor-bridge"),
      );
    handle("agentkib:cursor:bridge-bundle", () => bridgeBundle());
    handle("agentkib:cursor:reveal-bridge-bundle", async () => {
      const bundle = await bridgeBundle();
      shell.showItemInFolder(bundle.path);
    });
    forward(
      "agentkib:workspace:cursor-bridge",
      RUNTIME_METHODS.cursorBridge,
      (request: unknown) => {
        const input = requireObject(request, "Cursor bridge request");
        const action = requireString(input.action, "action");
        if (
          !["status", "connect", "disconnect"].includes(action) ||
          Object.keys(input).some((key) => !["action", "workspaceId", "bindingId"].includes(key))
        )
          throw new TypeError("Unsupported Cursor bridge request");
        if (action === "status" && input.bindingId !== undefined)
          throw new TypeError("Unexpected Cursor binding identity");
        return {
          action,
          workspaceId: requireString(input.workspaceId, "workspaceId"),
          ...(action === "disconnect"
            ? { bindingId: requireString(input.bindingId, "bindingId") }
            : input.bindingId !== undefined
              ? { bindingId: optionalString(input.bindingId, "bindingId") }
              : {}),
        };
      },
    );
    forward("agentkib:workspace:scan", RUNTIME_METHODS.scanWorkspace, (project: unknown) => ({
      project: requireString(project, "project"),
    }));
    forward(
      "agentkib:workspace:prepare-manifest",
      RUNTIME_METHODS.prepareManifest,
      (project: unknown) => ({
        project: requireString(project, "project"),
      }),
    );
    forward(
      "agentkib:workspace:resolve-context",
      RUNTIME_METHODS.resolveContext,
      (project: unknown, cwd: unknown, agent: unknown) => ({
        project: requireString(project, "project"),
        cwd: requireString(cwd, "cwd"),
        agent: requireAgentKind(agent),
      }),
    );
    forward("agentkib:workspace:add", RUNTIME_METHODS.addWorkspace, (workspacePath: unknown) => ({
      path: requireString(workspacePath, "path"),
    }));
    forward("agentkib:workspace:refresh", RUNTIME_METHODS.refreshWorkspace, (id: unknown) => ({
      id: requireString(id, "id"),
    }));
    forward("agentkib:workspace:exclude", RUNTIME_METHODS.excludeWorkspace, (id: unknown) => ({
      id: requireString(id, "id"),
    }));
    forward(
      "agentkib:workspace:restore-excluded",
      RUNTIME_METHODS.restoreExcludedWorkspace,
      (workspacePath: unknown) => ({
        path: requireString(workspacePath, "path"),
      }),
    );
    forward(
      "agentkib:workspace:doctor-report",
      RUNTIME_METHODS.workspaceDoctorReport,
      (id: unknown) => ({
        id: requireString(id, "id"),
      }),
    );
    forward(
      "agentkib:workspace:git-summary",
      RUNTIME_METHODS.workspaceGitSummary,
      (id: unknown) => ({
        id: requireString(id, "workspaceId"),
      }),
    );
    forward(
      "agentkib:workspace:git-history",
      RUNTIME_METHODS.workspaceGitHistory,
      (id: unknown, query: unknown) => ({
        workspaceId: requireString(id, "workspaceId"),
        query: requireObject(query, "git history query"),
      }),
    );
    forward(
      "agentkib:workspace:git-commit-files",
      RUNTIME_METHODS.gitCommitFiles,
      (id: unknown, oid: unknown) => ({
        workspaceId: requireString(id, "workspaceId"),
        oid: requireString(oid, "oid"),
      }),
    );
    forward(
      "agentkib:workspace:git-diff",
      RUNTIME_METHODS.gitDiff,
      (id: unknown, request: unknown) => ({
        workspaceId: requireString(id, "workspaceId"),
        request: requireObject(request, "git diff request"),
      }),
    );
    forward("agentkib:workspace:sessions", RUNTIME_METHODS.workspaceSessions, (id: unknown) => ({
      workspaceId: requireString(id, "workspaceId"),
    }));
    forward(
      "agentkib:workspace:session-status",
      RUNTIME_METHODS.workspaceSessionStatus,
      (id: unknown) => ({
        workspaceId: requireString(id, "workspaceId"),
      }),
    );
    forward(
      "agentkib:workspace:refresh-sessions",
      RUNTIME_METHODS.refreshWorkspaceSessions,
      (id: unknown, force: unknown) => ({
        workspaceId: requireString(id, "workspaceId"),
        force: force === undefined ? false : requireBoolean(force, "force"),
      }),
    );
    forward(
      "agentkib:session:events",
      RUNTIME_METHODS.sessionEvents,
      (id: unknown, cursor: unknown, limit: unknown) => ({
        sessionId: requireString(id, "sessionId"),
        cursor: optionalString(cursor, "cursor"),
        limit: optionalPositiveInteger(limit, "limit"),
      }),
    );
    forward(
      "agentkib:session:source-capability",
      RUNTIME_METHODS.sessionSourceCapability,
      (sessionId: unknown) => ({ sessionId: requireString(sessionId, "sessionId") }),
    );
    forward(
      "agentkib:session:native-imports",
      RUNTIME_METHODS.listNativeImports,
      (workspaceId: unknown) => ({ workspaceId: requireString(workspaceId, "workspaceId") }),
    );
    forward(
      "agentkib:session:prepare-handoff",
      RUNTIME_METHODS.prepareSessionHandoff,
      (request: unknown) => ({
        request: requireObject(request, "handoff request"),
      }),
    );
    forward(
      "agentkib:session:plan-mcp-connection",
      RUNTIME_METHODS.planSessionMcpConnection,
      (workspaceId: unknown, targetAgent: unknown) => ({
        workspaceId: requireString(workspaceId, "workspaceId"),
        targetAgent: requireString(targetAgent, "targetAgent"),
      }),
    );
    forward(
      "agentkib:session:sanitize-handoff",
      RUNTIME_METHODS.sanitizeSessionHandoff,
      (format: unknown, editedContent: unknown) => ({
        format: requireString(format, "format"),
        editedContent: requireText(editedContent, "editedContent"),
      }),
    );
    forward(
      "agentkib:session:plan-handoff",
      RUNTIME_METHODS.planSessionHandoff,
      (
        sessionId: unknown,
        workspaceId: unknown,
        filename: unknown,
        format: unknown,
        editedContent: unknown,
        targetAgent: unknown,
        mode: unknown,
        sourceFingerprint: unknown,
        acceptLosses: unknown,
        historyBudgetTokens: unknown,
        archiveId: unknown,
        targetFingerprint: unknown,
        targetSurface: unknown,
        bindingId: unknown,
      ) => ({
        sessionId: requireString(sessionId, "sessionId"),
        workspaceId: requireString(workspaceId, "workspaceId"),
        filename: requireString(filename, "filename"),
        format: requireString(format, "format"),
        editedContent:
          editedContent === undefined ? undefined : requireText(editedContent, "editedContent"),
        targetAgent: requireString(targetAgent, "targetAgent"),
        mode: requireString(mode, "mode"),
        sourceFingerprint: requireString(sourceFingerprint, "sourceFingerprint"),
        acceptLosses: requireBoolean(acceptLosses, "acceptLosses"),
        historyBudgetTokens: requirePositiveInteger(historyBudgetTokens, "historyBudgetTokens"),
        archiveId: optionalString(archiveId, "archiveId"),
        targetFingerprint: optionalString(targetFingerprint, "targetFingerprint"),
        targetSurface: optionalString(targetSurface, "targetSurface"),
        bindingId: optionalString(bindingId, "bindingId"),
      }),
    );
    forward(
      "agentkib:session:continue-handoff",
      RUNTIME_METHODS.continueSessionHandoff,
      (changeSet: unknown, launchRequest: unknown, approveHome: unknown) => ({
        changeSet: requireObject(changeSet, "changeSet"),
        launchRequest: requireObject(launchRequest, "launchRequest"),
        approveHome: requireBoolean(approveHome, "approveHome"),
      }),
    );
    forward(
      "agentkib:session:launch-handoff",
      RUNTIME_METHODS.launchSessionHandoff,
      (launchRequest: unknown) => ({
        ...requireObject(launchRequest, "launchRequest"),
      }),
    );
    forward("agentkib:workspace:openers", RUNTIME_METHODS.listWorkspaceOpeners, (id: unknown) => ({
      workspaceId: requireString(id, "workspaceId"),
    }));
    forward(
      "agentkib:workspace:open",
      RUNTIME_METHODS.openWorkspaceWithApp,
      (id: unknown, openerId: unknown) => ({
        workspaceId: requireString(id, "workspaceId"),
        openerId: optionalString(openerId, "openerId"),
      }),
    );
  }

  function registerFeatureIpc(): void {
    forward(
      "agentkib:changes:plan",
      RUNTIME_METHODS.planChanges,
      (project: unknown, manifest: unknown, includeHome: unknown) => ({
        project: requireString(project, "project"),
        manifest: requireObject(manifest, "manifest"),
        includeHome: requireBoolean(includeHome, "includeHome"),
      }),
    );
    forward(
      "agentkib:changes:apply",
      RUNTIME_METHODS.applyChanges,
      (changeSet: unknown, approveHome: unknown, launchRequest: unknown) => ({
        changeSet: requireObject(changeSet, "changeSet"),
        approveHome: requireBoolean(approveHome, "approveHome"),
        ...(launchRequest === undefined
          ? {}
          : { launchRequest: requireObject(launchRequest, "launchRequest") }),
      }),
    );
    forward(
      "agentkib:memories:list",
      RUNTIME_METHODS.listMemories,
      (project: unknown, status: unknown) => ({
        project: requireString(project, "project"),
        status: status === undefined ? null : optionalString(status, "status"),
      }),
    );
    forward(
      "agentkib:memories:search",
      RUNTIME_METHODS.searchMemories,
      (project: unknown, query: unknown, limit: unknown) => ({
        project: requireString(project, "project"),
        query: requireText(query, "query"),
        limit: optionalPositiveInteger(limit, "limit") ?? 50,
      }),
    );
    forward(
      "agentkib:memories:propose",
      RUNTIME_METHODS.proposeMemory,
      (project: unknown, proposal: unknown) => ({
        project: requireString(project, "project"),
        proposal: requireObject(proposal, "proposal"),
      }),
    );
    forward(
      "agentkib:memories:review",
      RUNTIME_METHODS.reviewMemory,
      (id: unknown, status: unknown, editedContent: unknown) => ({
        id: requireString(id, "id"),
        status: requireString(status, "status"),
        editedContent: optionalString(editedContent, "editedContent"),
      }),
    );
    forward(
      "agentkib:sessions:clear-index",
      RUNTIME_METHODS.clearSessionIndex,
      (workspaceId: unknown) => ({
        workspaceId: optionalString(workspaceId, "workspaceId"),
      }),
    );
    handle("agentkib:sessions:set-index-enabled", (_event, enabled: unknown) => {
      return runtime()
        .request(RUNTIME_METHODS.setSessionIndexEnabled, {
          value: requireBoolean(enabled, "enabled"),
        })
        .then(withElectronRuntimeCapabilities);
    });

    forward("agentkib:skills:catalog", RUNTIME_METHODS.listSkillCatalog, (force: unknown) => ({
      force: typeof force === "boolean" ? force : false,
    }));
    forward("agentkib:skills:discover", RUNTIME_METHODS.discoverSkills, (url: unknown) => ({
      url: requireText(url, "url"),
    }));
    forward("agentkib:skills:installed", RUNTIME_METHODS.listInstalledSkills);
    forward(
      "agentkib:skills:prepare-install",
      RUNTIME_METHODS.prepareSkillInstall,
      (source: unknown) => ({
        source: requireObject(source, "source"),
      }),
    );
    forward(
      "agentkib:skills:apply-operation",
      RUNTIME_METHODS.applySkillOperation,
      (token: unknown, allowModified: unknown) => ({
        token: requireString(token, "token"),
        confirmed: true,
        allowModified: typeof allowModified === "boolean" ? allowModified : false,
      }),
    );
    forward("agentkib:skills:check-updates", RUNTIME_METHODS.checkSkillUpdates);
    forward(
      "agentkib:skills:prepare-update",
      RUNTIME_METHODS.prepareSkillUpdate,
      (name: unknown) => ({
        name: requireString(name, "name"),
      }),
    );
    forward("agentkib:skills:rollback", RUNTIME_METHODS.rollbackSkill, (name: unknown) => ({
      name: requireString(name, "name"),
      confirmed: true,
    }));
    forward("agentkib:skills:uninstall", RUNTIME_METHODS.uninstallSkill, (name: unknown) => ({
      name: requireString(name, "name"),
      confirmed: true,
    }));
    forward("agentkib:skills:removed", RUNTIME_METHODS.listRemovedSkills);
    forward("agentkib:skills:restore", RUNTIME_METHODS.restoreSkill, (id: unknown) => ({
      id: requireString(id, "id"),
      confirmed: true,
    }));
    forward(
      "agentkib:skills:read-file",
      RUNTIME_METHODS.readSkillFile,
      (name: unknown, filePath: unknown) => ({
        name: requireString(name, "name"),
        path: requireString(filePath, "path"),
      }),
    );

    forward("agentkib:mcp:hub-status", RUNTIME_METHODS.mcpHubStatus);
    forward(
      "agentkib:mcp:update-network",
      RUNTIME_METHODS.updateMcpNetwork,
      (settings: unknown) => ({
        settings: requireObject(settings, "settings"),
      }),
    );
    forward("agentkib:mcp:list-servers", RUNTIME_METHODS.listMcpServers, (project: unknown) => ({
      project: optionalString(project, "project") ?? null,
    }));
    forward(
      "agentkib:mcp:get-server",
      RUNTIME_METHODS.getMcpServer,
      (serverId: unknown, project: unknown) => ({
        serverId: requireString(serverId, "serverId"),
        project: optionalString(project, "project") ?? null,
      }),
    );
    forward(
      "agentkib:mcp:save-server",
      RUNTIME_METHODS.saveMcpServer,
      (server: unknown, project: unknown) => ({
        server: requireObject(server, "server"),
        project: optionalString(project, "project") ?? null,
      }),
    );
    forward(
      "agentkib:mcp:save-local-values",
      RUNTIME_METHODS.saveMcpLocalValues,
      (serverId: unknown, env: unknown, headers: unknown, project: unknown) => ({
        serverId: requireString(serverId, "serverId"),
        env: requireObject(env, "env"),
        headers: requireObject(headers, "headers"),
        project: optionalString(project, "project") ?? null,
      }),
    );
    forward(
      "agentkib:mcp:remove-server",
      RUNTIME_METHODS.removeMcpServer,
      (serverId: unknown, project: unknown) => ({
        serverId: requireString(serverId, "serverId"),
        project: optionalString(project, "project") ?? null,
      }),
    );
    forward(
      "agentkib:mcp:probe-runtime",
      RUNTIME_METHODS.probeMcpRuntime,
      (serverId: unknown, project: unknown) => ({
        serverId: requireString(serverId, "serverId"),
        project: optionalString(project, "project") ?? null,
      }),
    );
    forward(
      "agentkib:mcp:start-oauth",
      RUNTIME_METHODS.startMcpOAuth,
      (serverId: unknown, project: unknown) => ({
        serverId: requireString(serverId, "serverId"),
        project: optionalString(project, "project") ?? null,
      }),
    );
    forward("agentkib:mcp:list-runtimes", RUNTIME_METHODS.listMcpRuntimes);
    forward(
      "agentkib:mcp:restart-runtime",
      RUNTIME_METHODS.restartMcpRuntime,
      (serverId: unknown, project: unknown) => ({
        serverId: requireString(serverId, "serverId"),
        project: optionalString(project, "project") ?? null,
      }),
    );
    forward("agentkib:mcp:stop-runtime", RUNTIME_METHODS.stopMcpRuntime, (serverId: unknown) => ({
      serverId: optionalString(serverId, "serverId") ?? null,
    }));
    forward(
      "agentkib:mcp:search-registry",
      RUNTIME_METHODS.searchMcpRegistry,
      (query: unknown) => ({
        query: requireText(query, "query"),
      }),
    );
    forward(
      "agentkib:mcp:refresh-registry",
      RUNTIME_METHODS.refreshMcpRegistry,
      (query: unknown) => ({
        query: requireText(query, "query"),
      }),
    );
    forward(
      "agentkib:mcp:install",
      RUNTIME_METHODS.installMcp,
      (entry: unknown, project: unknown) => ({
        entry: requireObject(entry, "entry"),
        project: optionalString(project, "project") ?? null,
        confirmed: true,
      }),
    );
    forward(
      "agentkib:mcp:update",
      RUNTIME_METHODS.updateMcp,
      (installationId: unknown, entry: unknown, project: unknown) => ({
        installationId: requireString(installationId, "installationId"),
        entry: requireObject(entry, "entry"),
        project: optionalString(project, "project") ?? null,
        confirmed: true,
      }),
    );
    forward("agentkib:mcp:list-installations", RUNTIME_METHODS.listMcpInstallations);
    forward("agentkib:mcp:uninstall", RUNTIME_METHODS.uninstallMcp, (installationId: unknown) => ({
      installationId: requireString(installationId, "installationId"),
      confirmed: true,
    }));
    forward("agentkib:mcp:scan-native", RUNTIME_METHODS.scanNativeMcp, (project: unknown) => ({
      project: optionalString(project, "project") ?? null,
    }));
    handle("agentkib:mcp:plan-migration", (_event, project: unknown, candidateIds: unknown) => {
      if (!Array.isArray(candidateIds)) throw new TypeError("candidateIds must be an array");
      return runtime().request(RUNTIME_METHODS.planMcpMigration, {
        project: requireString(project, "project"),
        candidateIds: candidateIds.map((id) => requireString(id, "candidateId")),
      });
    });

    forward("agentkib:insights:heatmap", RUNTIME_METHODS.insightsHeatmap, (query: unknown) => ({
      query: requireObject(query, "query"),
    }));
    forward(
      "agentkib:insights:agent-usage",
      RUNTIME_METHODS.agentUsageBreakdown,
      (query: unknown) => ({
        query: requireObject(query, "query"),
      }),
    );
    forward(
      "agentkib:insights:model-usage",
      RUNTIME_METHODS.modelUsageBreakdown,
      (query: unknown) => ({
        query: requireObject(query, "query"),
      }),
    );
    forward(
      "agentkib:insights:workspace-usage",
      RUNTIME_METHODS.workspaceUsageBreakdown,
      (query: unknown) => ({
        query: requireObject(query, "query"),
      }),
    );
    forward(
      "agentkib:insights:repository-commits",
      RUNTIME_METHODS.repositoryCommitBreakdown,
      (query: unknown) => ({
        query: requireObject(query, "query"),
      }),
    );
    forward("agentkib:insights:achievements", RUNTIME_METHODS.achievements);
    forward("agentkib:insights:git-identities", RUNTIME_METHODS.gitIdentities);
    forward(
      "agentkib:insights:add-git-identity-alias",
      RUNTIME_METHODS.addGitIdentityAlias,
      (email: unknown) => ({
        email: requireString(email, "email"),
      }),
    );
    forward(
      "agentkib:insights:set-git-identity-enabled",
      RUNTIME_METHODS.setGitIdentityEnabled,
      (id: unknown, enabled: unknown) => ({
        id: requireString(id, "id"),
        enabled: requireBoolean(enabled, "enabled"),
      }),
    );
  }

  registerWorkspaceIpc();
  registerFeatureIpc();
}
