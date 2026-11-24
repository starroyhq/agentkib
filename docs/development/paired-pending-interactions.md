# Paired approvals and questions

Paired clients can read `pendingInteractions` from the single-session `/api/web/v1/live` response and from the same session's stream. Replace the list at each snapshot, treating an absent list as empty. In a state patch, an empty list clears the previous list and an omitted field leaves it unchanged. The `/access` response advertises `pendingInteractions: { version: 1, deviceVerification: false }` for a paired device. The `pendingInteractions` field in a Provider declaration gives its approval and question coverage. Missing declarations mean the client has no contract for the new controls.

Each item includes:

- `kind` and `binding`, which contains the host's session ID, backend incarnation, native turn ID, native request ID and live revision.
- `summary`, the Agent's words when supplied, and the command, cwd, tool name or parameters reported for the actual operation. Use the summary as quoted text. The host derives risk from the operation, workspace and native metadata.
- `risk.level` and a host-generated `risk.reason` code. `high` covers deletion, network access, dependency installation, `git push`, out-of-workspace paths and operations the host cannot safely classify. `file-modification` covers known workspace edits. `low` covers ordinary questions, reads, tests and static checks. The host checks the command shape and its explicit paths. The Agent's original runtime and sandbox still govern the code it executes, including test scripts.
- `decisions`, projected from the native candidate set and the current device grants. Each choice declares its `kind`, `scope`, `available`, and `verification`. Use `lockScreen` to determine which choices can be offered on that surface. `confirmation` marks a scope expansion for in-app confirmation and still requires the host's `extendedApproval` grant.
- `questions` for an answerable questionnaire or a read-only prompt. It uses the same question IDs, options and flags as the older `questions` list.

Codex, managed Claude Code and DSH supply approvals and questions. Devin and Antigravity supply approvals through ACP. A terminal-only Claude session has its existing state reporting. DSH questions that carry native approval or plan-review intent stay visible for review and are handled in the native interface.

## Submit and reconcile

Use the existing `/approve` or `/answer` route, the current `/access` `bootId`, the item binding's `sessionId`, `turnId`, `revision` as `expectedRevision`, and its native ID as `approvalId` or `questionId`. For a new submission use a fresh UUID as `requestId`. Add `interactionDecisionId` from the item and `interactionRuntimeBootId` from the binding. For an answer also send the existing `answers` object keyed by question ID. The host resolves the decision from its current native candidates and rechecks device grants, the workspace, the backend incarnation and the request binding.

`interaction_expired` means the client must refresh the card and discard the old selection. `interaction_decision_unavailable` means the selected control is gone or no longer allowed. The existing `/requests/<requestId>` reads the original device-scoped receipt. On a duplicate acknowledgement or loss of connection, poll that receipt and use the existing accepted, not-dispatched and unknown outcomes. An unknown result stays pending verification. Do not automatically submit the decision again.

High-risk authorization has only a one-time scope and requires in-app device user verification, using Face ID on iOS. Hosts currently report `deviceVerification: false` because the paired protocol has no trusted device-verification assertion. They refuse high-risk remote authorization with `interaction_verification_required`. A client claim that its local prompt succeeded cannot authorize execution. The native host controls and non-authorizing decisions remain available according to their existing grants.

Older clients may still use the existing fields and request bodies. The paired host enforces the risk policy even without the new decision ID, so an older client cannot authorize a high-risk operation remotely. New clients reading an older host get the legacy response and can leave the new controls disabled. None of these fields changes the underlying Agent or public protocol version.
