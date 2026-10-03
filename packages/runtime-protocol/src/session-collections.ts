/** Conversation-only buckets. These IDs never identify a filesystem workspace. */
export const SESSION_COLLECTIONS = {
  projectless: "session-collection:codex:projectless",
  unclassified: "session-collection:codex:unclassified",
} as const;
export type SessionCollection = keyof typeof SESSION_COLLECTIONS;
export function sessionCollection(id: string): SessionCollection | null {
  return id === SESSION_COLLECTIONS.projectless
    ? "projectless"
    : id === SESSION_COLLECTIONS.unclassified
      ? "unclassified"
      : null;
}
