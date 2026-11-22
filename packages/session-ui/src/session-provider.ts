import {
  sessionProviderDeclaration,
  type ConversationSessionSummary,
  type SessionCapabilities,
  type SessionProviderDeclaration,
} from "@agentkib/web-client";

export function resolveSessionProvider(
  session?: Pick<ConversationSessionSummary, "id" | "agent">,
  capabilities?: Pick<SessionCapabilities, "sessionId" | "provider">,
): SessionProviderDeclaration | undefined {
  if (!session) return undefined;
  const declared = sessionProviderDeclaration(session.agent);
  if (!declared) return undefined;
  const reported = capabilities?.sessionId === session.id ? capabilities.provider : undefined;
  if (!reported) return declared;
  if (
    reported.commands ||
    reported.connection ||
    reported.queue ||
    reported.permissionField ||
    reported.activities
  )
    return reported;

  // Legacy declarations omit all integration fields, including the registered connection kind.
  return {
    ...reported,
    commands: declared.commands,
    connection: declared.connection,
    queue: declared.queue,
    permissionField: declared.permissionField,
    activities: declared.activities,
  };
}
