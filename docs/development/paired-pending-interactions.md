# Paired approvals and questions

Paired clients can read `pendingInteractions` from the single-session `/api/web/v1/live` response and from the same session's stream. Replace the list at each snapshot, treating an absent list as empty. In a state patch, an empty list clears the previous list and an omitted field leaves it unchanged. The `/access` response advertises `pendingInteractions: { version: 1 }` for a paired device. The `pendingInteractions` field in a Provider declaration gives its approval and question coverage. Missing declarations mean the client has no contract for the new controls.

Each item includes:

- `kind` and `binding`, which contains the host's session ID, backend incarnation, native turn ID, native request ID and live revision.
- `summary`, the Agent's words when supplied, and the command, cwd, tool name or parameters reported for the actual operation. Use the summary as quoted text. The host derives risk from the operation, workspace and native metadata.
- `risk.level` and a host-generated `risk.reason` code. `high` covers deletion, network access, dependency installation, `git push`, out-of-workspace paths and operations the host cannot safely classify. `file-modification` covers known workspace edits. `low` covers ordinary questions, reads, tests and static checks. The host checks the command shape and its explicit paths. The Agent's original runtime and sandbox still govern the code it executes, including test scripts.
- `decisions`, projected from the native candidate set and the current device grants. Each choice declares its `kind`, `scope`, and `available`. A named choice without a standardized action uses `kind: "native"` and its native `label`. Use `lockScreen` to identify one-time allow and deny choices. Additional scopes follow the provider's existing grants.
- `questions` for an answerable questionnaire or a read-only prompt. It uses the same question IDs, options and flags as the older `questions` list.

Codex, managed Claude Code and DSH supply approvals and questions. Devin and Antigravity supply approvals through ACP. A terminal-only Claude session has its existing state reporting. DSH questions that carry native approval or plan-review intent use the same answer route and grants as its other questions.

## Submit and reconcile

Use the existing `/approve` or `/answer` route, the current `/access` `bootId`, the item binding's `sessionId`, `turnId`, `revision` as `expectedRevision`, and its native ID as `approvalId` or `questionId`. For a new submission use a fresh UUID as `requestId`. Add `interactionDecisionId` from the item and `interactionRuntimeBootId` from the binding. For an answer also send the existing `answers` object keyed by question ID. The host resolves the decision from its current native candidates and rechecks device grants, the workspace, the backend incarnation and the request binding.

`interaction_expired` means the client must refresh the card and discard the old selection. `interaction_decision_unavailable` means the selected control is gone or no longer allowed. The existing `/requests/<requestId>` reads the original device-scoped receipt. On a duplicate acknowledgement or loss of connection, poll that receipt and use the existing accepted, not-dispatched and unknown outcomes. An unknown result stays pending verification. Do not automatically submit the decision again.

Risk is display information on every client. Paired Web and phone clients can select the same native decisions as the desktop when the device has the corresponding grants. Approvals require `device.approve`, provider-declared extended approvals and native decision payloads require `extendedApproval`, and answers require `device.send`.

Older clients may still use the existing fields and request bodies. New clients reading an older host get the legacy response and can leave the new controls disabled. The underlying Agent and public protocol versions remain compatible.
