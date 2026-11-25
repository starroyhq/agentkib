import {
  managedAgentOf,
  sessionProviderDeclaration,
  type Access,
  type SessionCapabilities,
  type SessionProviderDeclaration,
} from "@agentkib/web-client";

export function sessionProviderControlsDisabled(
  access: Pick<Access, "disabledSessionProviders"> | null | undefined,
  agent: string | undefined,
  reason?: string | null,
): boolean {
  const managed = managedAgentOf(agent);
  return (
    reason === "antigravity-acp-disabled" ||
    !!(managed && access?.disabledSessionProviders?.[managed])
  );
}

export function resolveSessionProvider(
  session?: { id: string; agent?: string },
  capabilities?: Pick<SessionCapabilities, "sessionId" | "provider">,
): SessionProviderDeclaration | undefined {
  if (!session) return undefined;
  const declared = sessionProviderDeclaration(session.agent);
  if (!declared) return undefined;
  const reported = capabilities?.sessionId === session.id ? capabilities.provider : undefined;
  if (!reported) return declared;
  const projectAgent = reported.projectAgent ?? declared.projectAgent;
  if (
    reported.commands ||
    reported.connection ||
    reported.queue ||
    reported.permissionField ||
    reported.activities ||
    reported.projectAgent
  )
    return reported.projectAgent === projectAgent ? reported : { ...reported, projectAgent };

  // Legacy declarations omit all integration fields, including the registered connection kind.
  return {
    ...reported,
    commands: declared.commands,
    connection: declared.connection,
    queue: declared.queue,
    permissionField: declared.permissionField,
    activities: declared.activities,
    projectAgent,
  };
}
