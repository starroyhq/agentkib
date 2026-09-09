import { createHmac } from "node:crypto";

/** Match the store's salted native identity, never a sole or first catalog entry. */
export function claudeAcceptanceTarget(
  sessions: Array<{ id: string; agent: string }>,
  nativeId: string,
  salt: unknown,
): string {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(nativeId) ||
    typeof salt !== "string" ||
    !/^[a-f0-9]{64}$/.test(salt)
  )
    throw new Error("invalid_acceptance_identity");
  const expected = createHmac("sha256", salt)
    .update(`conversation:claude-code:${nativeId}`)
    .digest("hex");
  const matches = sessions.filter(
    (session) => session.agent === "claude-code" && session.id === expected,
  );
  if (matches.length !== 1) throw new Error("acceptance_session_not_found");
  return expected;
}
