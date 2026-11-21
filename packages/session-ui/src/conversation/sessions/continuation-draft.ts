import type { CodexContextResource, ResolvedHistoryReference } from "@agentkib/web-client";

/** Draft files stay in memory; uploaded identities remain scoped to their original session. */
export type ContinuationComposerDraft = {
  files: File[];
  resources: CodexContextResource[];
};
export type ContinuationDraft = ContinuationComposerDraft & {
  historyReferences: ResolvedHistoryReference[];
};

export function continuationResources(resources: CodexContextResource[]): CodexContextResource[] {
  // IDs and directory cursors are scoped to the source session and its revision.
  // A name alone cannot prove identity, so keep a removable reference for explicit reselection.
  return resources.map((item) => ({
    id: `continuation:${crypto.randomUUID()}`,
    kind: item.kind,
    name: item.name,
    description: item.description,
    available: false,
    reason: "continuation-reference-reselect",
  }));
}
