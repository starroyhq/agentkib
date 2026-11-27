// Generated from packages/runtime-protocol/remote-contract.json (contract v1). Do not edit.

abstract final class AgentKibRemoteContract {
  static const remoteContractVersion = 1;

  static const protocolVersion = 17;

  static const conversationProtocolVersion = 2;

  static const remoteVersions = {
    "runtime": {
      "major": 17,
      "minimum": 17,
    },
    "conversation": {
      "major": 2,
      "minimum": 2,
    },
    "remoteApi": {
      "major": 1,
      "minimum": 1,
    },
    "hostDiscovery": {
      "advertised": 1,
      "accepted": [
        1,
        2,
      ],
    },
    "features": {
      "readStateVersion": 1,
      "taskSummaryVersion": 1,
      "approvalRulesVersion": 1,
      "approvalAuditVersion": 1,
      "pushPolicyVersion": 1,
      "pushActivityVersion": 1,
      "pendingInteractions": 1,
      "answerNotesVersion": 1,
      "push": 1,
      "approvalActionsVersion": 1,
      "accountLoginProofVersion": 1,
      "directConnection": 1,
    },
  };

  static const remoteFeatureVersions = {
    "readStateVersion": 1,
    "taskSummaryVersion": 1,
    "approvalRulesVersion": 1,
    "approvalAuditVersion": 1,
    "pushPolicyVersion": 1,
    "pushActivityVersion": 1,
    "pendingInteractions": 1,
    "answerNotesVersion": 1,
    "push": 1,
    "approvalActionsVersion": 1,
    "accountLoginProofVersion": 1,
    "directConnection": 1,
  };

  static const remoteCapabilities = {
    "info": {
      "read": "read",
      "send": "send",
      "approve": "approve",
    },
    "access": {
      "readStateVersion": "readStateVersion",
      "taskSummaryVersion": "taskSummaryVersion",
      "approvalRulesVersion": "approvalRulesVersion",
      "approvalAuditVersion": "approvalAuditVersion",
      "pushPolicyVersion": "pushPolicyVersion",
      "pushActivityVersion": "pushActivityVersion",
      "pendingInteractions": "pendingInteractions",
      "answerNotesVersion": "answerNotesVersion",
      "push": "push",
      "historySearch": "historySearch",
      "accountLogin": "accountLogin",
      "disabledSessionProviders": "disabledSessionProviders",
      "directConnection": "directConnection",
    },
    "device": {
      "send": "send",
      "approve": "approve",
      "manage": "manage",
      "files": "files",
      "attachments": "attachments",
      "advancedControl": "advancedControl",
      "organize": "organize",
      "settings": "settings",
      "extendedApproval": "extendedApproval",
    },
    "runtime": [
      "shared-schema-15",
      "preferences",
      "quit-work",
      "cached-workspace-reads",
      "workspace-writes",
      "discovery-persistence",
      "native-assets",
      "manifest-import",
      "context-preview",
      "context-doctor",
      "changesets",
      "catalog",
      "memory",
      "native-memory",
      "git",
      "insight-reads",
      "session-cache",
      "session-events",
      "session-index",
      "skills",
      "agent-tools",
      "obsidian",
      "mcp",
      "remote-gateways",
      "workspace-storage",
      "quota-collection",
    ],
  };

  static const remoteConversationEvents = {
    "userMessage": {
      "kind": "user-message",
    },
    "agentMessage": {
      "kind": "agent-message",
    },
    "toolSummary": {
      "kind": "tool-summary",
    },
    "compactionBoundary": {
      "kind": "compaction-boundary",
      "timestampField": "timestamp",
      "triggerField": "compaction_trigger",
      "triggers": [
        "auto",
        "manual",
        "unknown",
      ],
    },
  };

  static const remoteHeaders = {
    "protocol": "X-AgentKib-Protocol",
  };

  static const remoteControlOutcomes = {
    "notDispatched": "not-dispatched",
    "unknown": "unknown",
  };

  static const remoteWorkerReportContract = {
    "field": "worker_reports",
    "eventKind": "user-message",
    "optional": true,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "reportId",
        "parts",
      ],
      "properties": {
        "reportId": {
          "type": "string",
          "description": "Identity of the recorded delivery.",
        },
        "omittedDetails": {
          "type": "boolean",
          "description": "Some details exceeded the delivery size budget.",
        },
        "parts": {
          "type": "array",
          "items": {
            "\$ref": "#/\$defs/WorkerReportPart",
          },
          "minItems": 1,
        },
      },
      "\$defs": {
        "WorkerReportKind": {
          "type": "string",
          "enum": [
            "turn-ended",
            "waiting-approval",
            "waiting-question",
            "stalled",
            "long-command",
            "restart-user-only",
            "restart-rate-limit",
            "restart-result",
            "offline",
            "recovered",
            "usage-limit",
            "interrupted-by-quit",
            "deferred-send",
            "user-intervention",
          ],
        },
        "WorkerReportWaitingItem": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "kind",
            "summary",
          ],
          "properties": {
            "kind": {
              "type": "string",
              "enum": [
                "command",
                "file-change",
                "question",
                "other",
              ],
            },
            "summary": {
              "type": "string",
            },
            "detail": {
              "type": "string",
            },
          },
        },
        "WorkerReportPart": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "kind",
            "workerSessionId",
            "workerName",
            "agent",
            "occurredAt",
            "requiresUser",
          ],
          "properties": {
            "kind": {
              "\$ref": "#/\$defs/WorkerReportKind",
            },
            "workerSessionId": {
              "type": "string",
            },
            "workerName": {
              "type": "string",
            },
            "agent": {
              "type": "string",
            },
            "workerRoleLabel": {
              "type": "string",
              "description": "Worker role label captured when this report was recorded.",
            },
            "occurredAt": {
              "type": "string",
              "description": "ISO 8601 event time, independent of delivery time.",
            },
            "requiresUser": {
              "type": "boolean",
            },
            "outcome": {
              "type": "string",
            },
            "durationMs": {
              "type": "integer",
              "minimum": 0,
            },
            "reply": {
              "type": "string",
              "description": "Worker reply Markdown captured for this report.",
            },
            "replyTruncated": {
              "type": "boolean",
            },
            "delegable": {
              "type": "boolean",
            },
            "waitingItems": {
              "type": "array",
              "items": {
                "\$ref": "#/\$defs/WorkerReportWaitingItem",
              },
            },
            "reasonCode": {
              "type": "string",
            },
            "resetAt": {
              "type": "string",
              "description": "ISO 8601 time.",
            },
            "autoContinueAt": {
              "type": "string",
              "description": "ISO 8601 time.",
            },
            "meta": {
              "type": "object",
              "additionalProperties": {
                "type": [
                  "string",
                  "number",
                  "boolean",
                ],
              },
            },
          },
        },
      },
    },
  };

  static const remoteWorkerRoleContract = {
    "operation": "worker-role",
    "controlOperation": "lead-worker-role",
    "input": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "label",
        "description",
      ],
      "properties": {
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 48,
        },
        "description": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1200,
        },
      },
    },
    "view": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "label",
        "description",
        "updatedBy",
        "updatedAt",
      ],
      "properties": {
        "label": {
          "type": "string",
        },
        "description": {
          "type": "string",
        },
        "updatedBy": {
          "type": "string",
          "enum": [
            "user",
            "project-agent",
          ],
        },
        "updatedAt": {
          "type": "string",
          "description": "ISO 8601 edit time.",
        },
      },
    },
    "change": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "workerSessionId",
        "roleLabel",
        "updatedBy",
        "updatedAt",
      ],
      "properties": {
        "workerSessionId": {
          "type": "string",
        },
        "roleLabel": {
          "type": [
            "string",
            "null",
          ],
          "description": "The saved label, or null when the role was cleared.",
        },
        "updatedBy": {
          "type": "string",
          "enum": [
            "user",
            "project-agent",
          ],
        },
        "updatedAt": {
          "type": "string",
          "description": "ISO 8601 edit time.",
        },
      },
    },
  };

  static const remoteSentAttachmentContract = {
    "field": "attachments",
    "eventKind": "user-message",
    "optional": true,
    "schema": {
      "type": "array",
      "minItems": 1,
      "items": {
        "\$ref": "#/\$defs/ConversationSentAttachment",
      },
      "\$defs": {
        "ConversationSentAttachment": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "name",
            "kind",
            "mimeType",
            "size",
            "available",
          ],
          "properties": {
            "name": {
              "type": "string",
              "description": "Display name from the host's attachment record.",
            },
            "kind": {
              "type": "string",
              "enum": [
                "image",
                "file",
              ],
            },
            "mimeType": {
              "type": "string",
              "description": "Media type stored by the host.",
            },
            "size": {
              "type": "integer",
              "minimum": 0,
              "description": "Recorded size in bytes.",
            },
            "available": {
              "type": "boolean",
              "description": "Whether the host can still read the attachment.",
            },
            "imageId": {
              "type": "string",
              "description": "Opaque session-images reference for a readable raster image.",
            },
          },
        },
      },
    },
  };

  static const remoteSessionQuestionContract = {
    "option": {
      "type": "object",
      "required": [
        "label",
      ],
      "properties": {
        "label": {
          "type": "string",
        },
        "description": {
          "type": "string",
        },
        "preview": {
          "type": "string",
          "description": "Optional display content for this label, shared by live and historical questions.",
        },
      },
    },
    "reply": {
      "type": "object",
      "required": [
        "answers",
      ],
      "properties": {
        "answers": {
          "type": "object",
          "additionalProperties": {
            "type": "array",
            "items": {
              "type": "string",
            },
          },
        },
        "answerNotes": {
          "type": "object",
          "description": "Optional notes keyed by question ID. The host obtains selected preview content from its pending question.",
          "additionalProperties": {
            "type": "string",
          },
        },
      },
    },
  };

  static const remoteRouteBase = "/api/web/v1";

  static const remoteRoute = {
    "abandonRequest": "/requests/abandon",
    "pushPolicy": "/push/policy",
    "pushActivity": "/push/activity",
    "approvalAudit": "/approval-audit",
    "approvalRules": "/approval-rules",
    "historyStatus": "/history/status",
    "access": "/access",
    "info": "/info",
    "catalog": "/catalog",
    "readState": "/read-state",
    "events": "/events",
    "sessionImages": "/session-images",
    "live": "/live",
    "stream": "/stream",
    "attachments": "/attachments",
    "codexCapabilities": "/codex/capabilities",
    "codexQueue": "/codex/queue",
    "codexSessionSettings": "/codex/session-settings",
    "codexGoals": "/codex/goals",
    "codexContextOptions": "/codex/context-options",
    "managedOptions": "/managed/options",
    "managedCapabilities": "/managed/capabilities",
    "managedInspect": "/managed/inspect",
    "managedContext": "/managed/context",
    "managedResumeCommand": "/managed/resume-command",
    "managedSettings": "/managed/settings",
    "managedQueue": "/managed/queue",
    "managedGoals": "/managed/goals",
    "managedResources": "/managed/resources",
    "managedProjectAgent": "/managed/project-agent",
    "filesWorkspaces": "/files/workspaces",
    "filesList": "/files/list",
    "filesText": "/files/text",
    "artifacts": "/artifacts",
    "artifactsResolve": "/artifacts/resolve",
    "diff": "/diff",
    "approvalRulesRevoke": "/approval-rules/revoke",
    "sessionPin": "/session-pin",
    "historySearch": "/history/search",
    "historyLocate": "/history/locate",
    "historyReferences": "/history/references",
    "historyConfigure": "/history/configure",
    "historyClear": "/history/clear",
    "historyRebuild": "/history/rebuild",
    "devinTerminal": "/devin/terminal",
    "pair": "/pair",
    "pairCancel": "/pair/cancel",
    "accountBinding": "/account-binding",
    "pushSubscribe": "/push/subscribe",
    "pushUnsubscribe": "/push/unsubscribe",
    "logout": "/logout",
    "send": "/send",
    "stop": "/stop",
    "approve": "/approve",
    "answer": "/answer",
    "codexQueueDelete": "/codex/queue-delete",
    "codexGoalSet": "/codex/goal-set",
    "codexGoalPause": "/codex/goal-pause",
    "codexGoalResume": "/codex/goal-resume",
    "codexGoalClear": "/codex/goal-clear",
    "managedCreate": "/managed/create",
    "managedRelease": "/managed/release",
    "managedReconcile": "/managed/reconcile",
    "managedAction": "/managed/action",
    "managedSettingsPrepare": "/managed/settings-prepare",
    "artifactTickets": "/artifact-tickets",
    "livePreviewTickets": "/live-preview-tickets",
    "attachmentsDelete": "/attachments/delete",
    "subagents": "/subagents",
    "subagentEvents": "/subagent/events",
    "codexInspect": "/codex/inspect",
    "receipt": "/requests/{requestId}",
    "socket": "/socket",
  };

  static const remoteRequestPath = {
    "abandonRequest": "requests/abandon",
    "pushPolicy": "push/policy",
    "pushActivity": "push/activity",
    "approvalAudit": "approval-audit",
    "approvalRules": "approval-rules",
    "historyStatus": "history/status",
    "access": "access",
    "info": "info",
    "catalog": "catalog",
    "readState": "read-state",
    "events": "events",
    "sessionImages": "session-images",
    "live": "live",
    "stream": "stream",
    "attachments": "attachments",
    "codexCapabilities": "codex/capabilities",
    "codexQueue": "codex/queue",
    "codexSessionSettings": "codex/session-settings",
    "codexGoals": "codex/goals",
    "codexContextOptions": "codex/context-options",
    "managedOptions": "managed/options",
    "managedCapabilities": "managed/capabilities",
    "managedInspect": "managed/inspect",
    "managedContext": "managed/context",
    "managedResumeCommand": "managed/resume-command",
    "managedSettings": "managed/settings",
    "managedQueue": "managed/queue",
    "managedGoals": "managed/goals",
    "managedResources": "managed/resources",
    "managedProjectAgent": "managed/project-agent",
    "filesWorkspaces": "files/workspaces",
    "filesList": "files/list",
    "filesText": "files/text",
    "artifacts": "artifacts",
    "artifactsResolve": "artifacts/resolve",
    "diff": "diff",
    "approvalRulesRevoke": "approval-rules/revoke",
    "sessionPin": "session-pin",
    "historySearch": "history/search",
    "historyLocate": "history/locate",
    "historyReferences": "history/references",
    "historyConfigure": "history/configure",
    "historyClear": "history/clear",
    "historyRebuild": "history/rebuild",
    "devinTerminal": "devin/terminal",
    "pair": "pair",
    "pairCancel": "pair/cancel",
    "accountBinding": "account-binding",
    "pushSubscribe": "push/subscribe",
    "pushUnsubscribe": "push/unsubscribe",
    "logout": "logout",
    "send": "send",
    "stop": "stop",
    "approve": "approve",
    "answer": "answer",
    "codexQueueDelete": "codex/queue-delete",
    "codexGoalSet": "codex/goal-set",
    "codexGoalPause": "codex/goal-pause",
    "codexGoalResume": "codex/goal-resume",
    "codexGoalClear": "codex/goal-clear",
    "managedCreate": "managed/create",
    "managedRelease": "managed/release",
    "managedReconcile": "managed/reconcile",
    "managedAction": "managed/action",
    "managedSettingsPrepare": "managed/settings-prepare",
    "artifactTickets": "artifact-tickets",
    "livePreviewTickets": "live-preview-tickets",
    "attachmentsDelete": "attachments/delete",
    "subagents": "subagents",
    "subagentEvents": "subagent/events",
    "codexInspect": "codex/inspect",
    "receipt": "requests/{requestId}",
    "socket": "socket",
  };

  static const remoteRoutePrefixes = {
    "managed": "/managed/",
    "files": "/files/",
    "history": "/history/",
    "requests": "/requests/",
  };

  static const remoteRouteSpecs = {
    "GET": {
      "/push/policy": {
        "lan": true,
      },
      "/push/activity": {
        "lan": true,
      },
      "/approval-audit": {
        "lan": true,
      },
      "/approval-rules": {
        "lan": true,
      },
      "/history/status": {
        "lan": true,
      },
      "/access": {
        "lan": true,
      },
      "/info": {
        "lan": true,
      },
      "/catalog": {
        "lan": true,
      },
      "/read-state": {
        "lan": true,
      },
      "/events": {
        "lan": true,
      },
      "/session-images": {
        "lan": true,
      },
      "/live": {
        "lan": true,
      },
      "/stream": {
        "lan": true,
      },
      "/attachments": {
        "lan": true,
      },
      "/codex/capabilities": {
        "lan": true,
      },
      "/codex/queue": {
        "lan": true,
      },
      "/codex/session-settings": {
        "lan": true,
      },
      "/codex/goals": {
        "lan": true,
      },
      "/codex/context-options": {
        "lan": true,
      },
      "/managed/options": {
        "lan": true,
      },
      "/managed/capabilities": {
        "lan": true,
      },
      "/managed/inspect": {
        "lan": true,
      },
      "/managed/context": {
        "lan": true,
      },
      "/managed/resume-command": {
        "lan": true,
      },
      "/managed/settings": <String, Object?>{},
      "/managed/queue": <String, Object?>{},
      "/managed/goals": <String, Object?>{},
      "/managed/resources": <String, Object?>{},
      "/managed/project-agent": <String, Object?>{},
      "/files/workspaces": {
        "lan": true,
      },
      "/files/list": {
        "lan": true,
      },
      "/files/text": {
        "lan": true,
      },
      "/artifacts": {
        "lan": true,
      },
      "/artifacts/resolve": {
        "lan": true,
      },
      "/diff": {
        "lan": true,
      },
      "/subagents": <String, Object?>{},
      "/subagent/events": <String, Object?>{},
    },
    "POST": {
      "/requests/abandon": {
        "lan": true,
        "control": true,
      },
      "/push/policy": {
        "control": true,
      },
      "/read-state": {
        "lan": true,
      },
      "/attachments": {
        "lan": true,
      },
      "/managed/project-agent": <String, Object?>{},
      "/approval-rules/revoke": {
        "control": true,
      },
      "/session-pin": {
        "lan": true,
      },
      "/history/search": {
        "lan": true,
      },
      "/history/locate": {
        "lan": true,
      },
      "/history/references": {
        "lan": true,
      },
      "/history/configure": <String, Object?>{},
      "/history/clear": <String, Object?>{},
      "/history/rebuild": <String, Object?>{},
      "/devin/terminal": <String, Object?>{},
      "/pair": {
        "lan": true,
      },
      "/pair/cancel": {
        "lan": true,
      },
      "/account-binding": {
        "lan": true,
      },
      "/push/subscribe": <String, Object?>{},
      "/push/unsubscribe": <String, Object?>{},
      "/logout": {
        "lan": true,
      },
      "/send": {
        "lan": true,
        "control": true,
      },
      "/stop": {
        "lan": true,
        "control": true,
      },
      "/approve": {
        "lan": true,
        "control": true,
      },
      "/answer": {
        "lan": true,
        "control": true,
      },
      "/codex/queue-delete": {
        "lan": true,
        "control": true,
      },
      "/codex/goal-set": {
        "lan": true,
        "control": true,
      },
      "/codex/goal-pause": {
        "lan": true,
        "control": true,
      },
      "/codex/goal-resume": {
        "lan": true,
        "control": true,
      },
      "/codex/goal-clear": {
        "lan": true,
        "control": true,
      },
      "/managed/create": {
        "lan": true,
        "control": true,
      },
      "/managed/release": {
        "lan": true,
        "control": true,
      },
      "/managed/reconcile": {
        "lan": true,
        "control": true,
      },
      "/managed/action": {
        "control": true,
      },
      "/managed/settings-prepare": <String, Object?>{},
      "/artifact-tickets": {
        "lan": true,
      },
      "/live-preview-tickets": <String, Object?>{},
      "/attachments/delete": {
        "lan": true,
      },
      "/codex/inspect": <String, Object?>{},
    },
  };

  static const remoteLegacyCodex = {
    "prefix": "/codex/",
    "postOperations": [
      "inspect",
      "resume",
      "steer",
      "queue-add",
      "queue-update",
      "queue-delete",
      "queue-reorder",
      "queue-start",
      "rename",
      "archive",
      "unarchive",
      "fork",
      "settings",
      "goal-set",
      "goal-pause",
      "goal-resume",
      "goal-clear",
    ],
    "postTarget": "/managed/action",
    "nonControlPath": "/codex/inspect",
    "getAliases": {
      "/codex/capabilities": "/managed/capabilities",
      "/codex/queue": "/managed/queue",
      "/codex/session-settings": "/managed/settings",
      "/codex/goals": "/managed/goals",
      "/codex/context-options": "/managed/resources",
    },
  };

  static const remoteManagedActionOperations = [
    "inspect",
    "resume",
    "steer",
    "queue-add",
    "queue-update",
    "queue-delete",
    "queue-reorder",
    "queue-start",
    "rename",
    "archive",
    "unarchive",
    "fork",
    "settings",
    "goal-set",
    "goal-pause",
    "goal-resume",
    "goal-clear",
    "queue-pause",
    "queue-resume",
    "queue-steer",
    "open-model-picker",
    "adopt-terminal",
    "handover-terminal",
    "usage-limit-cancel",
    "usage-limit-continue",
    "delete",
    "compact",
    "terminals-clean",
  ];

  static const remoteReceiptRoute = {
    "path": "/requests/{requestId}",
    "method": "GET",
    "lan": true,
  };

  static const remoteSocketRoute = {
    "path": "/socket",
    "method": "GET",
    "transport": "websocket",
  };

  static const remoteErrorCodes = {
    "accessChanged": "access_changed",
    "accessEnded": "access_ended",
    "accountLoginRequired": "account_login_required",
    "accountLoginUnavailable": "account_login_unavailable",
    "accountUnavailable": "account_unavailable",
    "alreadyPaired": "already_paired",
    "antigravityAcpList": "antigravity-acp-list",
    "antigravityAcpRecord": "antigravity-acp-record",
    "antigravityAcpWorkspaceUnavailable": "antigravity-acp-workspace-unavailable",
    "antigravityDatabaseRecord": "antigravity-database-record",
    "antigravityDatabaseSource": "antigravity-database-source",
    "antigravityLocalLimit": "antigravity-local-limit",
    "antigravityNativeList": "antigravity-native-list",
    "antigravitySummaryRecord": "antigravity-summary-record",
    "antigravitySummarySource": "antigravity-summary-source",
    "antigravityTrajectoryRecord": "antigravity-trajectory-record",
    "antigravityAcpDisabled": "antigravity-acp-disabled",
    "antigravityCliUnavailable": "antigravity-cli-unavailable",
    "antigravityLoginRequired": "antigravity-login-required",
    "antigravityRunFailed": "antigravity-run-failed",
    "antigravityUsageLimited": "antigravity-usage-limited",
    "approvalAuditUnavailable": "approval_audit_unavailable",
    "approvalRuleReadOnly": "approval_rule_read_only",
    "approvalRuleRevokeFailed": "approval_rule_revoke_failed",
    "approvalRuleStale": "approval_rule_stale",
    "approvalRulesUnavailable": "approval_rules_unavailable",
    "approvalUnavailable": "approval_unavailable",
    "artifactAccessChanged": "artifact_access_changed",
    "artifactAccessDenied": "artifact_access_denied",
    "artifactBundleDenied": "artifact_bundle_denied",
    "artifactBundleTooLarge": "artifact_bundle_too_large",
    "artifactChanged": "artifact_changed",
    "artifactDirectoryTooLarge": "artifact_directory_too_large",
    "artifactInvalidHost": "artifact_invalid_host",
    "artifactInvalidOrigin": "artifact_invalid_origin",
    "artifactInvalidPath": "artifact_invalid_path",
    "artifactInvalidPreflight": "artifact_invalid_preflight",
    "artifactInvalidRange": "artifact_invalid_range",
    "artifactInvalidTtl": "artifact_invalid_ttl",
    "artifactInvalidUtf8": "artifact_invalid_utf8",
    "artifactMethodNotAllowed": "artifact_method_not_allowed",
    "artifactNotDirectory": "artifact_not_directory",
    "artifactNotFile": "artifact_not_file",
    "artifactNotFound": "artifact_not_found",
    "artifactNotText": "artifact_not_text",
    "artifactPathDenied": "artifact_path_denied",
    "artifactPreparationBusy": "artifact_preparation_busy",
    "artifactReferenceLimit": "artifact_reference_limit",
    "artifactRequestLimit": "artifact_request_limit",
    "artifactRootUnavailable": "artifact_root_unavailable",
    "artifactSensitivePath": "artifact_sensitive_path",
    "artifactSnapshotLimit": "artifact_snapshot_limit",
    "artifactTicketExpired": "artifact_ticket_expired",
    "artifactTicketLimit": "artifact_ticket_limit",
    "artifactTooLarge": "artifact_too_large",
    "artifactTransferLimit": "artifact_transfer_limit",
    "artifactUnavailable": "artifact_unavailable",
    "assetTooLarge": "asset_too_large",
    "attachmentChanged": "attachment_changed",
    "attachmentChangedDetail": "attachment-changed",
    "attachmentEmpty": "attachment_empty",
    "attachmentIndexInvalid": "attachment_index_invalid",
    "attachmentIndexMissingReferences": "attachment_index_missing_references",
    "attachmentInUse": "attachment_in_use",
    "attachmentInvalid": "attachment-invalid",
    "attachmentNotFound": "attachment_not_found",
    "attachmentRequestConflict": "attachment_request_conflict",
    "attachmentRequestSettled": "attachment_request_settled",
    "attachmentRequestsInvalid": "attachment_requests_invalid",
    "attachmentsRequireSameOrigin": "attachments_require_same_origin",
    "attachmentsTooLarge": "attachments_too_large",
    "attachmentStorageFull": "attachment_storage_full",
    "attachmentsUnavailable": "attachments_unavailable",
    "attachmentsUnsupported": "attachments-unsupported",
    "attachmentTooLarge": "attachment_too_large",
    "attachmentUnavailable": "attachment-unavailable",
    "attachmentWorkspaceChanged": "attachment_workspace_changed",
    "attachmentWorkspaceUnavailable": "attachment_workspace_unavailable",
    "bodyTooLarge": "body_too_large",
    "capabilityUnavailable": "capability_unavailable",
    "catalogReadTimeout": "catalog_read_timeout",
    "catalogStale": "catalog_stale",
    "catalogStaleDetail": "catalog-stale",
    "claudeBackgroundSessionRunning": "claude-background-session-running",
    "claudeCliTooOld": "claude-cli-too-old",
    "claudeCliUnavailable": "claude-cli-unavailable",
    "claudeCommandBackground": "claude-command-background",
    "claudeCommandClear": "claude-command-clear",
    "claudeCommandGoal": "claude-command-goal",
    "claudeCommandOwnerOnly": "claude-command-owner-only",
    "claudeCommandRename": "claude-command-rename",
    "claudeCommandSettings": "claude-command-settings",
    "claudeImagesTooLarge": "claude_images_too_large",
    "claudeOwnerBusy": "claude-owner-busy",
    "claudeOwnerCheckUnavailable": "claude-owner-check-unavailable",
    "claudeSessionFingerprintChanged": "claude-session-fingerprint-changed",
    "claudeStartupModelsUnavailable": "claude-startup-models-unavailable",
    "claudeTerminalExitRefused": "claude-terminal-exit-refused",
    "claudeTerminalForegroundUnconfirmed": "claude-terminal-foreground-unconfirmed",
    "claudeTerminalHandoverModelUnconfirmed": "claude-terminal-handover-model-unconfirmed",
    "claudeTerminalHandoverPermissionUnconfirmed": "claude-terminal-handover-permission-unconfirmed",
    "claudeTerminalHandoverUnavailable": "claude-terminal-handover-unavailable",
    "claudeTerminalHandoverWorkspaceUnavailable": "claude-terminal-handover-workspace-unavailable",
    "claudeTerminalReportOwnerUnavailable": "claude-terminal-report-owner-unavailable",
    "claudeTerminalReportUnconfirmed": "claude-terminal-report-unconfirmed",
    "clientLimit": "client_limit",
    "codexCliUnavailable": "codex-cli-unavailable",
    "codexCliVersionTooOld": "codex-cli-version-too-old",
    "codexCliVersionUnavailable": "codex-cli-version-unavailable",
    "codexContextUnavailable": "codex_context_unavailable",
    "codexOwnerBusy": "codex-owner-busy",
    "codexOwnerCheckUnavailable": "codex-owner-check-unavailable",
    "codexPolicyMismatch": "codex-policy-mismatch",
    "codexSandboxMismatch": "codex-sandbox-mismatch",
    "codexTurnStartRejected": "codex-turn-start-rejected",
    "codexWorkspaceMismatch": "codex-workspace-mismatch",
    "codexWritableRootsMismatch": "codex-writable-roots-mismatch",
    "computerSignedOut": "computer_signed_out",
    "connectionFailed": "connection_failed",
    "contextUnavailable": "context_unavailable",
    "controlOutcomeUnconfirmed": "control-outcome-unconfirmed",
    "controlPreflightRejected": "control_preflight_rejected",
    "controlUnavailable": "control_unavailable",
    "createPermissionUnconfirmed": "create-permission-unconfirmed",
    "crossSiteRequest": "cross_site_request",
    "csrfRejected": "csrf_rejected",
    "decisionUnavailable": "decision_unavailable",
    "defaultsUnavailable": "defaults_unavailable",
    "delegationPaused": "delegation-paused",
    "deviceLimit": "device_limit",
    "deadlineExceeded": "deadline-exceeded",
    "devinAuthProbeFailed": "devin-auth-probe-failed",
    "devinCliUnavailable": "devin-cli-unavailable",
    "devinCliUpdateRequired": "devin-cli-update-required",
    "devinLoginRequired": "devin-login-required",
    "devinRunFailed": "devin-run-failed",
    "devinRunStopped": "devin-run-stopped",
    "devinSessionNotFound": "devin-session-not-found",
    "devinSourceBusy": "devin-source-busy",
    "devinSourceChanged": "devin-source-changed",
    "devinSourceCorrupt": "devin-source-corrupt",
    "devinSourceDenied": "devin-source-denied",
    "devinSourceLimit": "devin-source-limit",
    "devinSourceRecord": "devin-source-record",
    "devinSourceUnavailable": "devin-source-unavailable",
    "devinSourceUnsafe": "devin-source-unsafe",
    "devinSourceUnsupported": "devin-source-unsupported",
    "backendClosing": "backend-closing",
    "workerFailed": "worker-failed",
    "devinWorkspaceUntrusted": "devin-workspace-untrusted",
    "dshAttachmentsUnavailable": "dsh-attachments-unavailable",
    "dshCommandAttachments": "dsh-command-attachments",
    "dshCommandFailed": "dsh-command-failed",
    "dshCommandFullAccess": "dsh-command-full-access",
    "dshCommandUnavailable": "dsh-command-unavailable",
    "dshCommandWindowOnly": "dsh-command-window-only",
    "dshCreateAmbiguous": "dsh-create-ambiguous",
    "dshCreateModelNotApplied": "dsh-create-model-not-applied",
    "dshCreateModelSelectionUnsupported": "dsh-create-model-selection-unsupported",
    "dshCreatePermissionNotApplied": "dsh-create-permission-not-applied",
    "dshCreatePermissionSelectionUnsupported": "dsh-create-permission-selection-unsupported",
    "dshExited": "dsh-exited",
    "dshLauncherUnavailable": "dsh-launcher-unavailable",
    "dshModelsUnavailable": "dsh-models-unavailable",
    "dshNativeStatusUnknown": "dsh-native-status-unknown",
    "dshRuntimeOffline": "dsh-runtime-offline",
    "dshSessionAmbiguous": "dsh-session-ambiguous",
    "dshSessionControllerUnavailable": "dsh-session-controller-unavailable",
    "dshSessionInUse": "dsh-session-in-use",
    "dshStartFailed": "dsh-start-failed",
    "dshVersionUnsupported": "dsh-version-unsupported",
    "duplicateRequest": "duplicate_request",
    "emptySettings": "empty_settings",
    "followerOperationUnverified": "follower-operation-unverified",
    "goalActionUnavailable": "goal-action-unavailable",
    "goalChanged": "goal-changed",
    "goalRoundsExhausted": "goal-rounds-exhausted",
    "goalTokenBudgetUnavailable": "goal-token-budget-unavailable",
    "historyOwnerChanged": "history-owner-changed",
    "historyReadRouteRequired": "history_read_route_required",
    "historyReferenceRangeInvalid": "history-reference-range-invalid",
    "historyReferencesNotSupported": "history_references_not_supported",
    "historyReferencesTooLarge": "history-references-too-large",
    "historyRequestCancelled": "history_request_cancelled",
    "historySearchCacheUnavailable": "history-search-cache-unavailable",
    "historySearchCursorInvalid": "history-search-cursor-invalid",
    "historySearchCursorStale": "history-search-cursor-stale",
    "historySearchDisabled": "history-search-disabled",
    "historySearchInputInvalid": "history-search-input-invalid",
    "historySourceChanged": "history-source-changed",
    "historySourceOwnerChanged": "history-source-owner-changed",
    "historySourceStale": "history-source-stale",
    "historySourceUnavailable": "history-source-unavailable",
    "imageChanged": "image_changed",
    "imageTooLarge": "image_too_large",
    "imageUnavailable": "image_unavailable",
    "imageUnsupported": "image_unsupported",
    "incompatibleProtocol": "incompatible_protocol",
    "interactionDecisionUnavailable": "interaction_decision_unavailable",
    "interactionExpired": "interaction_expired",
    "invalidAccountLogin": "invalid_account_login",
    "invalidAccountProof": "invalid_account_proof",
    "invalidAgent": "invalid_agent",
    "invalidAnswers": "invalid_answers",
    "invalidApprovalAuditCursor": "invalid_approval_audit_cursor",
    "invalidApprovalAuditQuery": "invalid_approval_audit_query",
    "invalidApprovalRuleRequest": "invalid_approval_rule_request",
    "invalidAttachmentImage": "invalid_attachment_image",
    "invalidAttachmentName": "invalid_attachment_name",
    "invalidAttachmentRequest": "invalid_attachment_request",
    "invalidAttachmentResponse": "invalid_attachment_response",
    "invalidAttachments": "invalid_attachments",
    "invalidAttachmentType": "invalid_attachment_type",
    "invalidCursor": "invalid_cursor",
    "invalidDecision": "invalid_decision",
    "invalidDiffKind": "invalid_diff_kind",
    "invalidDirectoryId": "invalid_directory_id",
    "invalidEffort": "invalid_effort",
    "invalidGoalIntent": "invalid_goal_intent",
    "invalidHistoryConfiguration": "invalid_history_configuration",
    "invalidHistoryLocation": "invalid_history_location",
    "invalidHistoryQuery": "invalid_history_query",
    "invalidHistoryReference": "invalid_history_reference",
    "invalidHistoryReferences": "invalid_history_references",
    "invalidHistoryRequest": "invalid_history_request",
    "invalidHistoryResolution": "invalid_history_resolution",
    "invalidHost": "invalid_host",
    "invalidImageId": "invalid_image_id",
    "invalidImageRequest": "invalid_image_request",
    "invalidImageResponse": "invalid_image_response",
    "invalidInput": "invalid_input",
    "invalidJson": "invalid_json",
    "invalidLanAddress": "invalid_lan_address",
    "invalidLeadDelegation": "invalid-lead-delegation",
    "invalidLeadRequest": "invalid-lead-request",
    "invalidLeadTurnLimit": "invalid-lead-turn-limit",
    "invalidLeadWorkspaces": "invalid-lead-workspaces",
    "invalidLimit": "invalid_limit",
    "invalidNotificationPolicy": "invalid_notification_policy",
    "invalidNotificationQuery": "invalid_notification_query",
    "invalidObjective": "invalid_objective",
    "invalidOperation": "invalid_operation",
    "invalidOrigin": "invalid_origin",
    "invalidPairingCode": "invalid_pairing_code",
    "invalidPath": "invalid_path",
    "invalidPolicy": "invalid-policy",
    "invalidPreflight": "invalid_preflight",
    "invalidPushSubscription": "invalid_push_subscription",
    "invalidQueueOrder": "invalid_queue_order",
    "invalidReadStateRequest": "invalid_read_state_request",
    "invalidRequest": "invalid_request",
    "invalidRequestDetail": "invalid-request",
    "invalidRequestId": "invalid_request_id",
    "invalidResourceIds": "invalid_resource_ids",
    "invalidRestoreDefaults": "invalid_restore_defaults",
    "invalidRevision": "invalid_revision",
    "invalidSavedConfiguration": "invalid_saved_configuration",
    "invalidSessionPinRequest": "invalid_session_pin_request",
    "invalidSubagentId": "invalid_subagent_id",
    "invalidText": "invalid_text",
    "invalidTokenBudget": "invalid_token_budget",
    "jsonRequired": "json_required",
    "lanAddressUnavailable": "lan_address_unavailable",
    "leadClaudeTerminalDisconnected": "lead-claude-terminal-disconnected",
    "leadExists": "lead-exists",
    "leadNotControllable": "lead-not-controllable",
    "leadRequiresManagedClaude": "lead-requires-managed-claude",
    "leadToolsUnavailable": "lead-tools-unavailable",
    "leadUnavailable": "lead-unavailable",
    "livePreviewCrossSite": "live_preview_cross_site",
    "livePreviewDenied": "live_preview_denied",
    "livePreviewExpired": "live_preview_expired",
    "livePreviewInvalidHost": "live_preview_invalid_host",
    "livePreviewMethodNotAllowed": "live_preview_method_not_allowed",
    "livePreviewNotFound": "live_preview_not_found",
    "livePreviewPortBlocked": "live_preview_port_blocked",
    "livePreviewPortReserved": "live_preview_port_reserved",
    "livePreviewRequestLimit": "live_preview_request_limit",
    "livePreviewTicketLimit": "live_preview_ticket_limit",
    "livePreviewUnreachable": "live_preview_unreachable",
    "livePreviewWorkerRequired": "live_preview_worker_required",
    "liveSessionLimit": "live-session-limit",
    "managedSessionLimit": "managed-session-limit",
    "methodNotAllowed": "method_not_allowed",
    "missingPrompt": "missing_prompt",
    "modelImagesUnsupported": "model-images-unsupported",
    "nativeEffortUnconfirmed": "native-effort-unconfirmed",
    "nativeModelUnconfirmed": "native-model-unconfirmed",
    "nativePolicyApprovalPolicyMismatch": "native-policy-approval-policy-mismatch",
    "nativePolicyApprovalsReviewerMismatch": "native-policy-approvals-reviewer-mismatch",
    "nativePolicyCwdMismatch": "native-policy-cwd-mismatch",
    "nativePolicyFullAccessRequired": "native-policy-full-access-required",
    "nativePolicySandboxNetworkMismatch": "native-policy-sandbox-network-mismatch",
    "nativePolicySandboxReadAccessMismatch": "native-policy-sandbox-read-access-mismatch",
    "nativePolicySandboxSlashTmpMismatch": "native-policy-sandbox-slash-tmp-mismatch",
    "nativePolicySandboxTmpdirMismatch": "native-policy-sandbox-tmpdir-mismatch",
    "nativePolicySandboxTypeMismatch": "native-policy-sandbox-type-mismatch",
    "nativePolicySandboxWritableRootsMismatch": "native-policy-sandbox-writable-roots-mismatch",
    "nativePolicyUnconfirmed": "native-policy-unconfirmed",
    "notFound": "not_found",
    "notificationPolicyUnavailable": "notification_policy_unavailable",
    "operationBusy": "operation_busy",
    "operationUnavailable": "operation_unavailable",
    "orchestrationUnavailable": "orchestration-unavailable",
    "outcomeGracePeriod": "outcome_grace_period",
    "outcomeUnknown": "outcome_unknown",
    "ownerOpenedElsewhere": "owner-opened-elsewhere",
    "ownerRequired": "owner_required",
    "pauseOriginalGoalBeforeHandoff": "pause-original-goal-before-handoff",
    "pendingLimit": "pending_limit",
    "pendingStorageUnavailable": "pending_storage_unavailable",
    "permissionDenied": "permission_denied",
    "platformUnsupported": "platform-unsupported",
    "portInUse": "port_in_use",
    "previewFailed": "preview_failed",
    "previewUnavailable": "preview_unavailable",
    "projectAgentFailed": "project_agent_failed",
    "promptTooLarge": "prompt_too_large",
    "providerControlNotAllowed": "provider_control_not_allowed",
    "pushActionUnavailable": "push_action_unavailable",
    "pushUnavailable": "push_unavailable",
    "questionUnavailable": "question_unavailable",
    "queueAttachmentsEditUnsupported": "queue_attachments_edit_unsupported",
    "queueItemUnavailable": "queue_item_unavailable",
    "queueRequiresRunningTurn": "queue_requires_running_turn",
    "queueTooLarge": "queue_too_large",
    "queueFull": "queue-full",
    "rateLimited": "rate_limited",
    "readStateConflict": "read_state_conflict",
    "readStateConflictDetail": "read-state-conflict",
    "readStateUnavailable": "read_state_unavailable",
    "readStateUnavailableDetail": "read-state-unavailable",
    "readStateUnsupported": "read_state_unsupported",
    "readStateUnsupportedDetail": "read-state-unsupported",
    "receiptUnavailable": "receipt_unavailable",
    "relayUnavailable": "relay_unavailable",
    "requestNotAuthorized": "request_not_authorized",
    "remoteEnableUnavailable": "remote_enable_unavailable",
    "remoteEnvironmentNotSupported": "remote-environment-not-supported",
    "requestConflict": "request_conflict",
    "requestFailed": "request_failed",
    "requestIdConflict": "request_id_conflict",
    "resourcesNotSupported": "resources_not_supported",
    "resourceUnavailable": "resource_unavailable",
    "responseTooLarge": "response_too_large",
    "rpcApplicationFailure": "rpc_application_failure",
    "rpcIncompatibleProtocol": "rpc_incompatible_protocol",
    "rpcInvalidParams": "rpc_invalid_params",
    "rpcInvalidRequest": "rpc_invalid_request",
    "rpcMethodNotFound": "rpc_method_not_found",
    "sessionBusy": "session-busy",
    "sessionCompacting": "session-compacting",
    "sessionControlNotAllowed": "session_control_not_allowed",
    "sessionImageChanged": "session-image-changed",
    "sessionImageInvalid": "session-image-invalid",
    "sessionImageTooLarge": "session-image-too-large",
    "sessionImageUnavailable": "session-image-unavailable",
    "sessionImageUnsupported": "session-image-unsupported",
    "sessionIndexStale": "session_index_stale",
    "sessionIndexStaleDetail": "session-index-stale",
    "sessionIsAProjectAgent": "session-is-a-project-agent",
    "sessionIsAWorker": "session-is-a-worker",
    "sessionManagedByAnotherRuntime": "session-managed-by-another-runtime",
    "sessionNotFound": "session_not_found",
    "sessionOpenElsewhere": "session-open-elsewhere",
    "sessionPinBusy": "session_pin_busy",
    "sessionPinUnavailable": "session_pin_unavailable",
    "sessionReleased": "session-released",
    "sessionUnknown": "session_unknown",
    "sessionWorkspaceMismatch": "session_workspace_mismatch",
    "sessionWorkspaceUnavailable": "session-workspace-unavailable",
    "settingUnavailable": "setting_unavailable",
    "staleBoot": "stale_boot",
    "staleClaudeRevision": "stale-Claude-revision",
    "sourcePartial": "source-partial",
    "sourceUnavailable": "source-unavailable",
    "staleCursor": "stale_cursor",
    "staleState": "stale_state",
    "stateUnavailable": "state_unavailable",
    "streamCursorTooLarge": "stream_cursor_too_large",
    "streamLimit": "stream_limit",
    "streamTooLarge": "stream_too_large",
    "streamUnavailable": "stream_unavailable",
    "subagentUnavailable": "subagent_unavailable",
    "subagentUnavailableDetail": "subagent-unavailable",
    "tooManyInputItems": "too_many_input_items",
    "transcriptCursorInvalid": "TRANSCRIPT_CURSOR_INVALID",
    "transcriptCursorStale": "TRANSCRIPT_CURSOR_STALE",
    "turnUnavailable": "turn_unavailable",
    "unpaired": "unpaired",
    "unsupportedCodexCliVersion": "unsupported-codex-cli-version",
    "unsupportedEffort": "unsupported_effort",
    "unsupportedEffortDetail": "unsupported-effort",
    "unsupportedHost": "unsupported_host",
    "unsupportedMode": "unsupported_mode",
    "unsupportedModel": "unsupported_model",
    "unsupportedModelDetail": "unsupported-model",
    "unsupportedPermissionMode": "unsupported_permission_mode",
    "unsupportedPolicy": "unsupported_policy",
    "unsupportedProviderResources": "unsupported_provider_resources",
    "unsupportedServiceTier": "unsupported_service_tier",
    "unsupportedServiceTierDetail": "unsupported-service-tier",
    "unverifiedInstallation": "unverified-installation",
    "uploadFailed": "upload_failed",
    "webBusy": "web-busy",
    "webServerError": "web_server_error",
    "webStartFailed": "web_start_failed",
    "webStateSaveFailed": "web_state_save_failed",
    "workerAgentUnsupported": "worker-agent-unsupported",
    "workerAssignmentChanged": "worker-assignment-changed",
    "workerLimitReached": "worker-limit-reached",
    "workerNotAssigned": "worker-not-assigned",
    "workerNotControllable": "worker-not-controllable",
    "workerNotRunning": "worker-not-running",
    "workerOutsideProject": "worker-outside-project",
    "workerProbeFailed": "worker-probe-failed",
    "workerTerminalDisconnected": "worker-terminal-disconnected",
    "workerUnavailable": "worker-unavailable",
    "workspaceNotAuthorized": "workspace_not_authorized",
    "workspaceUnavailable": "workspace-unavailable",
  };

  static const remoteErrorRetryPolicies = [
    "unclassified",
    "never",
    "after-refresh",
    "after-backoff",
    "after-user-action",
    "reconcile-only",
  ];

  static const remoteErrorContract = {
    "accessChanged": {
      "code": "access_changed",
      "retry": "unclassified",
      "http": {
        "status": 409,
        "overrides": {
          "accessRevokedDuringRequest": 403,
        },
      },
      "ipc": {
        "kind": "none",
      },
    },
    "accessEnded": {
      "code": "access_ended",
      "retry": "unclassified",
      "http": {
        "status": 401,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "accountLoginRequired": {
      "code": "account_login_required",
      "retry": "unclassified",
      "http": {
        "status": 401,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "accountLoginUnavailable": {
      "code": "account_login_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 503,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "accountUnavailable": {
      "code": "account_unavailable",
      "retry": "unclassified",
      "ipc": {
        "kind": "transport",
      },
    },
    "alreadyPaired": {
      "code": "already_paired",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "antigravityAcpList": {
      "code": "antigravity-acp-list",
      "retry": "after-backoff",
      "ipc": {
        "kind": "none",
      },
    },
    "antigravityAcpRecord": {
      "code": "antigravity-acp-record",
      "retry": "after-backoff",
      "ipc": {
        "kind": "none",
      },
    },
    "antigravityAcpWorkspaceUnavailable": {
      "code": "antigravity-acp-workspace-unavailable",
      "retry": "after-user-action",
      "ipc": {
        "kind": "none",
      },
    },
    "antigravityDatabaseRecord": {
      "code": "antigravity-database-record",
      "retry": "after-backoff",
      "ipc": {
        "kind": "none",
      },
    },
    "antigravityDatabaseSource": {
      "code": "antigravity-database-source",
      "retry": "after-backoff",
      "ipc": {
        "kind": "none",
      },
    },
    "antigravityLocalLimit": {
      "code": "antigravity-local-limit",
      "retry": "never",
      "ipc": {
        "kind": "none",
      },
    },
    "antigravityNativeList": {
      "code": "antigravity-native-list",
      "retry": "after-backoff",
      "ipc": {
        "kind": "none",
      },
    },
    "antigravitySummaryRecord": {
      "code": "antigravity-summary-record",
      "retry": "after-backoff",
      "ipc": {
        "kind": "none",
      },
    },
    "antigravitySummarySource": {
      "code": "antigravity-summary-source",
      "retry": "after-backoff",
      "ipc": {
        "kind": "none",
      },
    },
    "antigravityTrajectoryRecord": {
      "code": "antigravity-trajectory-record",
      "retry": "after-backoff",
      "ipc": {
        "kind": "none",
      },
    },
    "antigravityAcpDisabled": {
      "code": "antigravity-acp-disabled",
      "retry": "never",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "antigravity-acp-disabled",
      },
    },
    "antigravityCliUnavailable": {
      "code": "antigravity-cli-unavailable",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "antigravity-cli-unavailable",
      },
    },
    "antigravityLoginRequired": {
      "code": "antigravity-login-required",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "antigravity-login-required",
      },
    },
    "antigravityRunFailed": {
      "code": "antigravity-run-failed",
      "retry": "reconcile-only",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "antigravity-run-failed",
      },
    },
    "antigravityUsageLimited": {
      "code": "antigravity-usage-limited",
      "retry": "after-backoff",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "antigravity-usage-limited",
      },
    },
    "approvalAuditUnavailable": {
      "code": "approval_audit_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 503,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "approvalRuleReadOnly": {
      "code": "approval_rule_read_only",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "approvalRuleRevokeFailed": {
      "code": "approval_rule_revoke_failed",
      "retry": "unclassified",
      "http": {
        "status": 503,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "approvalRuleStale": {
      "code": "approval_rule_stale",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "approvalRulesUnavailable": {
      "code": "approval_rules_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 503,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "approvalUnavailable": {
      "code": "approval_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactAccessChanged": {
      "code": "artifact_access_changed",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactAccessDenied": {
      "code": "artifact_access_denied",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactBundleDenied": {
      "code": "artifact_bundle_denied",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactBundleTooLarge": {
      "code": "artifact_bundle_too_large",
      "retry": "unclassified",
      "http": {
        "status": 413,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactChanged": {
      "code": "artifact_changed",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactDirectoryTooLarge": {
      "code": "artifact_directory_too_large",
      "retry": "unclassified",
      "http": {
        "status": 413,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactInvalidHost": {
      "code": "artifact_invalid_host",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactInvalidOrigin": {
      "code": "artifact_invalid_origin",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactInvalidPath": {
      "code": "artifact_invalid_path",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactInvalidPreflight": {
      "code": "artifact_invalid_preflight",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactInvalidRange": {
      "code": "artifact_invalid_range",
      "retry": "unclassified",
      "http": {
        "status": 416,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactInvalidTtl": {
      "code": "artifact_invalid_ttl",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactInvalidUtf8": {
      "code": "artifact_invalid_utf8",
      "retry": "unclassified",
      "http": {
        "status": 415,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactMethodNotAllowed": {
      "code": "artifact_method_not_allowed",
      "retry": "unclassified",
      "http": {
        "status": 405,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactNotDirectory": {
      "code": "artifact_not_directory",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactNotFile": {
      "code": "artifact_not_file",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactNotFound": {
      "code": "artifact_not_found",
      "retry": "unclassified",
      "http": {
        "status": 404,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactNotText": {
      "code": "artifact_not_text",
      "retry": "unclassified",
      "http": {
        "status": 415,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactPathDenied": {
      "code": "artifact_path_denied",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactPreparationBusy": {
      "code": "artifact_preparation_busy",
      "retry": "unclassified",
      "http": {
        "status": 429,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactReferenceLimit": {
      "code": "artifact_reference_limit",
      "retry": "unclassified",
      "http": {
        "status": 413,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactRequestLimit": {
      "code": "artifact_request_limit",
      "retry": "unclassified",
      "http": {
        "status": 429,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactRootUnavailable": {
      "code": "artifact_root_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 404,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactSensitivePath": {
      "code": "artifact_sensitive_path",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactSnapshotLimit": {
      "code": "artifact_snapshot_limit",
      "retry": "unclassified",
      "http": {
        "status": 413,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactTicketExpired": {
      "code": "artifact_ticket_expired",
      "retry": "unclassified",
      "http": {
        "status": 410,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactTicketLimit": {
      "code": "artifact_ticket_limit",
      "retry": "unclassified",
      "http": {
        "status": 429,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactTooLarge": {
      "code": "artifact_too_large",
      "retry": "unclassified",
      "http": {
        "status": 413,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactTransferLimit": {
      "code": "artifact_transfer_limit",
      "retry": "unclassified",
      "http": {
        "status": 429,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "artifactUnavailable": {
      "code": "artifact_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 500,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "assetTooLarge": {
      "code": "asset_too_large",
      "retry": "unclassified",
      "http": {
        "status": 413,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "attachmentChanged": {
      "code": "attachment_changed",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "attachmentChangedDetail": {
      "code": "attachment-changed",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "attachment-changed",
      },
    },
    "attachmentEmpty": {
      "code": "attachment_empty",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "attachmentIndexInvalid": {
      "code": "attachment_index_invalid",
      "retry": "unclassified",
      "http": {
        "status": 503,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "attachmentIndexMissingReferences": {
      "code": "attachment_index_missing_references",
      "retry": "unclassified",
      "http": {
        "status": 503,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "attachmentInUse": {
      "code": "attachment_in_use",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "attachmentInvalid": {
      "code": "attachment-invalid",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "attachment-invalid",
      },
    },
    "attachmentNotFound": {
      "code": "attachment_not_found",
      "retry": "unclassified",
      "http": {
        "status": 404,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "attachmentRequestConflict": {
      "code": "attachment_request_conflict",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "attachmentRequestSettled": {
      "code": "attachment_request_settled",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "attachmentRequestsInvalid": {
      "code": "attachment_requests_invalid",
      "retry": "unclassified",
      "http": {
        "status": 503,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "attachmentsRequireSameOrigin": {
      "code": "attachments_require_same_origin",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "attachmentsTooLarge": {
      "code": "attachments_too_large",
      "retry": "unclassified",
      "http": {
        "status": 413,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "attachmentStorageFull": {
      "code": "attachment_storage_full",
      "retry": "unclassified",
      "http": {
        "status": 507,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "attachmentsUnavailable": {
      "code": "attachments_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "attachmentsUnsupported": {
      "code": "attachments-unsupported",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "attachments-unsupported",
      },
    },
    "attachmentTooLarge": {
      "code": "attachment_too_large",
      "retry": "unclassified",
      "http": {
        "status": 413,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "attachmentUnavailable": {
      "code": "attachment-unavailable",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "attachment-unavailable",
      },
    },
    "attachmentWorkspaceChanged": {
      "code": "attachment_workspace_changed",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "attachmentWorkspaceUnavailable": {
      "code": "attachment_workspace_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "bodyTooLarge": {
      "code": "body_too_large",
      "retry": "unclassified",
      "http": {
        "status": 413,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "capabilityUnavailable": {
      "code": "capability_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
        "overrides": {
          "routeDenied": 403,
          "handlerUnavailable": 404,
          "serviceUnavailable": 503,
        },
      },
      "ipc": {
        "kind": "none",
      },
    },
    "catalogReadTimeout": {
      "code": "catalog_read_timeout",
      "retry": "unclassified",
      "http": {
        "status": 504,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "catalogStale": {
      "code": "catalog_stale",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "catalog-stale",
      },
    },
    "catalogStaleDetail": {
      "code": "catalog-stale",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "catalog-stale",
      },
    },
    "claudeBackgroundSessionRunning": {
      "code": "claude-background-session-running",
      "retry": "after-backoff",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "claude-background-session-running",
      },
    },
    "claudeCliTooOld": {
      "code": "claude-cli-too-old",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "claude-cli-too-old",
      },
    },
    "claudeCliUnavailable": {
      "code": "claude-cli-unavailable",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "claude-cli-unavailable",
      },
    },
    "claudeCommandBackground": {
      "code": "claude-command-background",
      "retry": "never",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "claude-command-background",
      },
    },
    "claudeCommandClear": {
      "code": "claude-command-clear",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "claude-command-clear",
      },
    },
    "claudeCommandGoal": {
      "code": "claude-command-goal",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "claude-command-goal",
      },
    },
    "claudeCommandOwnerOnly": {
      "code": "claude-command-owner-only",
      "retry": "never",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "claude-command-owner-only",
      },
    },
    "claudeCommandRename": {
      "code": "claude-command-rename",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "claude-command-rename",
      },
    },
    "claudeCommandSettings": {
      "code": "claude-command-settings",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "claude-command-settings",
      },
    },
    "claudeImagesTooLarge": {
      "code": "claude_images_too_large",
      "retry": "unclassified",
      "http": {
        "status": 413,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "claudeOwnerBusy": {
      "code": "claude-owner-busy",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "claude-owner-busy",
      },
    },
    "claudeOwnerCheckUnavailable": {
      "code": "claude-owner-check-unavailable",
      "retry": "after-refresh",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "claude-owner-check-unavailable",
      },
    },
    "claudeSessionFingerprintChanged": {
      "code": "claude-session-fingerprint-changed",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "claude-session-fingerprint-changed",
      },
    },
    "claudeStartupModelsUnavailable": {
      "code": "claude-startup-models-unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "claude-startup-models-unavailable",
      },
    },
    "claudeTerminalExitRefused": {
      "code": "claude-terminal-exit-refused",
      "retry": "after-refresh",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "claude-terminal-exit-refused",
      },
    },
    "claudeTerminalForegroundUnconfirmed": {
      "code": "claude-terminal-foreground-unconfirmed",
      "retry": "after-refresh",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "claude-terminal-foreground-unconfirmed",
      },
    },
    "claudeTerminalHandoverModelUnconfirmed": {
      "code": "claude-terminal-handover-model-unconfirmed",
      "retry": "after-refresh",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "claude-terminal-handover-model-unconfirmed",
      },
    },
    "claudeTerminalHandoverPermissionUnconfirmed": {
      "code": "claude-terminal-handover-permission-unconfirmed",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "claude-terminal-handover-permission-unconfirmed",
      },
    },
    "claudeTerminalHandoverUnavailable": {
      "code": "claude-terminal-handover-unavailable",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "claude-terminal-handover-unavailable",
      },
    },
    "claudeTerminalHandoverWorkspaceUnavailable": {
      "code": "claude-terminal-handover-workspace-unavailable",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "claude-terminal-handover-workspace-unavailable",
      },
    },
    "claudeTerminalReportOwnerUnavailable": {
      "code": "claude-terminal-report-owner-unavailable",
      "retry": "after-refresh",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "claude-terminal-report-owner-unavailable",
      },
    },
    "claudeTerminalReportUnconfirmed": {
      "code": "claude-terminal-report-unconfirmed",
      "retry": "reconcile-only",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "claude-terminal-report-unconfirmed",
      },
    },
    "clientLimit": {
      "code": "client_limit",
      "retry": "unclassified",
      "http": {
        "status": 429,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "codexCliUnavailable": {
      "code": "codex-cli-unavailable",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "codex-cli-unavailable",
      },
    },
    "codexCliVersionTooOld": {
      "code": "codex-cli-version-too-old",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "codex-cli-version-too-old",
      },
    },
    "codexCliVersionUnavailable": {
      "code": "codex-cli-version-unavailable",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "codex-cli-version-unavailable",
      },
    },
    "codexContextUnavailable": {
      "code": "codex_context_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 503,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "codexOwnerBusy": {
      "code": "codex-owner-busy",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "codex-owner-busy",
      },
    },
    "codexOwnerCheckUnavailable": {
      "code": "codex-owner-check-unavailable",
      "retry": "after-refresh",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "codex-owner-check-unavailable",
      },
    },
    "codexPolicyMismatch": {
      "code": "codex-policy-mismatch",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "codex-policy-mismatch",
      },
    },
    "codexSandboxMismatch": {
      "code": "codex-sandbox-mismatch",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "codex-sandbox-mismatch",
      },
    },
    "codexTurnStartRejected": {
      "code": "codex-turn-start-rejected",
      "retry": "unclassified",
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "codex-turn-start-rejected",
      },
    },
    "codexWorkspaceMismatch": {
      "code": "codex-workspace-mismatch",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "codex-workspace-mismatch",
      },
    },
    "codexWritableRootsMismatch": {
      "code": "codex-writable-roots-mismatch",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "codex-writable-roots-mismatch",
      },
    },
    "computerSignedOut": {
      "code": "computer_signed_out",
      "retry": "unclassified",
      "ipc": {
        "kind": "transport",
      },
    },
    "connectionFailed": {
      "code": "connection_failed",
      "retry": "unclassified",
      "ipc": {
        "kind": "none",
      },
    },
    "contextUnavailable": {
      "code": "context_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "controlOutcomeUnconfirmed": {
      "code": "control-outcome-unconfirmed",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "control-outcome-unconfirmed",
      },
    },
    "controlPreflightRejected": {
      "code": "control_preflight_rejected",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "controlUnavailable": {
      "code": "control_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "createPermissionUnconfirmed": {
      "code": "create-permission-unconfirmed",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "create-permission-unconfirmed",
      },
    },
    "crossSiteRequest": {
      "code": "cross_site_request",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "csrfRejected": {
      "code": "csrf_rejected",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "decisionUnavailable": {
      "code": "decision_unavailable",
      "retry": "unclassified",
      "ipc": {
        "kind": "none",
      },
    },
    "defaultsUnavailable": {
      "code": "defaults_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "defaults_unavailable",
      },
    },
    "delegationPaused": {
      "code": "delegation-paused",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "delegation-paused",
      },
    },
    "deviceLimit": {
      "code": "device_limit",
      "retry": "unclassified",
      "http": {
        "status": 429,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "deadlineExceeded": {
      "code": "deadline-exceeded",
      "retry": "after-backoff",
      "ipc": {
        "kind": "none",
      },
    },
    "devinAuthProbeFailed": {
      "code": "devin-auth-probe-failed",
      "retry": "after-backoff",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "devin-auth-probe-failed",
      },
    },
    "devinCliUnavailable": {
      "code": "devin-cli-unavailable",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "devin-cli-unavailable",
      },
    },
    "devinCliUpdateRequired": {
      "code": "devin-cli-update-required",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "devin-cli-update-required",
      },
    },
    "devinLoginRequired": {
      "code": "devin-login-required",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "devin-login-required",
      },
    },
    "devinRunFailed": {
      "code": "devin-run-failed",
      "retry": "reconcile-only",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "devin-run-failed",
      },
    },
    "devinRunStopped": {
      "code": "devin-run-stopped",
      "retry": "reconcile-only",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "devin-run-stopped",
      },
    },
    "devinSessionNotFound": {
      "code": "devin-session-not-found",
      "retry": "reconcile-only",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "devin-session-not-found",
      },
    },
    "devinSourceBusy": {
      "code": "devin-source-busy",
      "retry": "after-backoff",
      "ipc": {
        "kind": "none",
      },
    },
    "devinSourceChanged": {
      "code": "devin-source-changed",
      "retry": "after-refresh",
      "ipc": {
        "kind": "none",
      },
    },
    "devinSourceCorrupt": {
      "code": "devin-source-corrupt",
      "retry": "after-user-action",
      "ipc": {
        "kind": "none",
      },
    },
    "devinSourceDenied": {
      "code": "devin-source-denied",
      "retry": "after-user-action",
      "ipc": {
        "kind": "none",
      },
    },
    "devinSourceLimit": {
      "code": "devin-source-limit",
      "retry": "never",
      "ipc": {
        "kind": "none",
      },
    },
    "devinSourceRecord": {
      "code": "devin-source-record",
      "retry": "after-user-action",
      "ipc": {
        "kind": "none",
      },
    },
    "devinSourceUnavailable": {
      "code": "devin-source-unavailable",
      "retry": "after-backoff",
      "ipc": {
        "kind": "none",
      },
    },
    "devinSourceUnsafe": {
      "code": "devin-source-unsafe",
      "retry": "after-user-action",
      "ipc": {
        "kind": "none",
      },
    },
    "devinSourceUnsupported": {
      "code": "devin-source-unsupported",
      "retry": "after-user-action",
      "ipc": {
        "kind": "none",
      },
    },
    "backendClosing": {
      "code": "backend-closing",
      "retry": "never",
      "ipc": {
        "kind": "none",
      },
    },
    "workerFailed": {
      "code": "worker-failed",
      "retry": "after-backoff",
      "ipc": {
        "kind": "none",
      },
    },
    "devinWorkspaceUntrusted": {
      "code": "devin-workspace-untrusted",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "devin-workspace-untrusted",
      },
    },
    "dshAttachmentsUnavailable": {
      "code": "dsh-attachments-unavailable",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-attachments-unavailable",
      },
    },
    "dshCommandAttachments": {
      "code": "dsh-command-attachments",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-command-attachments",
      },
    },
    "dshCommandFailed": {
      "code": "dsh-command-failed",
      "retry": "reconcile-only",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-command-failed",
      },
    },
    "dshCommandFullAccess": {
      "code": "dsh-command-full-access",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-command-full-access",
      },
    },
    "dshCommandUnavailable": {
      "code": "dsh-command-unavailable",
      "retry": "after-refresh",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-command-unavailable",
      },
    },
    "dshCommandWindowOnly": {
      "code": "dsh-command-window-only",
      "retry": "never",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-command-window-only",
      },
    },
    "dshCreateAmbiguous": {
      "code": "dsh-create-ambiguous",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-create-ambiguous",
      },
    },
    "dshCreateModelNotApplied": {
      "code": "dsh-create-model-not-applied",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-create-model-not-applied",
      },
    },
    "dshCreateModelSelectionUnsupported": {
      "code": "dsh-create-model-selection-unsupported",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-create-model-selection-unsupported",
      },
    },
    "dshCreatePermissionNotApplied": {
      "code": "dsh-create-permission-not-applied",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-create-permission-not-applied",
      },
    },
    "dshCreatePermissionSelectionUnsupported": {
      "code": "dsh-create-permission-selection-unsupported",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-create-permission-selection-unsupported",
      },
    },
    "dshExited": {
      "code": "dsh-exited",
      "retry": "after-backoff",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-exited",
      },
    },
    "dshLauncherUnavailable": {
      "code": "dsh-launcher-unavailable",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-launcher-unavailable",
      },
    },
    "dshModelsUnavailable": {
      "code": "dsh-models-unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-models-unavailable",
      },
    },
    "dshNativeStatusUnknown": {
      "code": "dsh-native-status-unknown",
      "retry": "after-refresh",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-native-status-unknown",
      },
    },
    "dshRuntimeOffline": {
      "code": "dsh-runtime-offline",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-runtime-offline",
      },
    },
    "dshSessionAmbiguous": {
      "code": "dsh-session-ambiguous",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "dsh-session-ambiguous",
      },
    },
    "dshSessionControllerUnavailable": {
      "code": "dsh-session-controller-unavailable",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "dsh-session-controller-unavailable",
      },
    },
    "dshSessionInUse": {
      "code": "dsh-session-in-use",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-session-in-use",
      },
    },
    "dshStartFailed": {
      "code": "dsh-start-failed",
      "retry": "after-backoff",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-start-failed",
      },
    },
    "dshVersionUnsupported": {
      "code": "dsh-version-unsupported",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "dsh-version-unsupported",
      },
    },
    "duplicateRequest": {
      "code": "duplicate_request",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "emptySettings": {
      "code": "empty_settings",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "empty_settings",
      },
    },
    "followerOperationUnverified": {
      "code": "follower-operation-unverified",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "follower-operation-unverified",
      },
    },
    "goalActionUnavailable": {
      "code": "goal-action-unavailable",
      "retry": "after-refresh",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "goal-action-unavailable",
      },
    },
    "goalChanged": {
      "code": "goal-changed",
      "retry": "after-refresh",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "goal-changed",
      },
    },
    "goalRoundsExhausted": {
      "code": "goal-rounds-exhausted",
      "retry": "never",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "goal-rounds-exhausted",
      },
    },
    "goalTokenBudgetUnavailable": {
      "code": "goal-token-budget-unavailable",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "goal-token-budget-unavailable",
      },
    },
    "historyOwnerChanged": {
      "code": "history-owner-changed",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "history-owner-changed",
      },
    },
    "historyReadRouteRequired": {
      "code": "history_read_route_required",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "historyReferenceRangeInvalid": {
      "code": "history-reference-range-invalid",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "history-reference-range-invalid",
      },
    },
    "historyReferencesNotSupported": {
      "code": "history_references_not_supported",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "historyReferencesTooLarge": {
      "code": "history-references-too-large",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "history-references-too-large",
      },
    },
    "historyRequestCancelled": {
      "code": "history_request_cancelled",
      "retry": "unclassified",
      "http": {
        "status": 408,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "historySearchCacheUnavailable": {
      "code": "history-search-cache-unavailable",
      "retry": "unclassified",
      "http": {
        "status": 410,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "history-search-cache-unavailable",
      },
    },
    "historySearchCursorInvalid": {
      "code": "history-search-cursor-invalid",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "history-search-cursor-invalid",
      },
    },
    "historySearchCursorStale": {
      "code": "history-search-cursor-stale",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "history-search-cursor-stale",
      },
    },
    "historySearchDisabled": {
      "code": "history-search-disabled",
      "retry": "unclassified",
      "http": {
        "status": 410,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "history-search-disabled",
      },
    },
    "historySearchInputInvalid": {
      "code": "history-search-input-invalid",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "history-search-input-invalid",
      },
    },
    "historySourceChanged": {
      "code": "history-source-changed",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "history-source-changed",
      },
    },
    "historySourceOwnerChanged": {
      "code": "history-source-owner-changed",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "history-source-owner-changed",
      },
    },
    "historySourceStale": {
      "code": "history-source-stale",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "history-source-stale",
      },
    },
    "historySourceUnavailable": {
      "code": "history-source-unavailable",
      "retry": "unclassified",
      "http": {
        "status": 410,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "history-source-unavailable",
      },
    },
    "imageChanged": {
      "code": "image_changed",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "session-image-changed",
      },
    },
    "imageTooLarge": {
      "code": "image_too_large",
      "retry": "unclassified",
      "http": {
        "status": 413,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "session-image-too-large",
      },
    },
    "imageUnavailable": {
      "code": "image_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 404,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "session-image-unavailable",
      },
    },
    "imageUnsupported": {
      "code": "image_unsupported",
      "retry": "unclassified",
      "http": {
        "status": 415,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "session-image-unsupported",
      },
    },
    "incompatibleProtocol": {
      "code": "incompatible_protocol",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32001,
      },
    },
    "interactionDecisionUnavailable": {
      "code": "interaction_decision_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "interactionExpired": {
      "code": "interaction_expired",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidAccountLogin": {
      "code": "invalid_account_login",
      "retry": "unclassified",
      "ipc": {
        "kind": "none",
      },
    },
    "invalidAccountProof": {
      "code": "invalid_account_proof",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidAgent": {
      "code": "invalid_agent",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidAnswers": {
      "code": "invalid_answers",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidApprovalAuditCursor": {
      "code": "invalid_approval_audit_cursor",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "invalid_approval_audit_cursor",
      },
    },
    "invalidApprovalAuditQuery": {
      "code": "invalid_approval_audit_query",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "invalid_approval_audit_cursor",
      },
    },
    "invalidApprovalRuleRequest": {
      "code": "invalid_approval_rule_request",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidAttachmentImage": {
      "code": "invalid_attachment_image",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidAttachmentName": {
      "code": "invalid_attachment_name",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidAttachmentRequest": {
      "code": "invalid_attachment_request",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidAttachmentResponse": {
      "code": "invalid_attachment_response",
      "retry": "unclassified",
      "ipc": {
        "kind": "none",
      },
    },
    "invalidAttachments": {
      "code": "invalid_attachments",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidAttachmentType": {
      "code": "invalid_attachment_type",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidCursor": {
      "code": "invalid_cursor",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "TRANSCRIPT_CURSOR_INVALID",
      },
    },
    "invalidDecision": {
      "code": "invalid_decision",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidDiffKind": {
      "code": "invalid_diff_kind",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidDirectoryId": {
      "code": "invalid_directory_id",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidEffort": {
      "code": "invalid_effort",
      "retry": "unclassified",
      "ipc": {
        "kind": "none",
      },
    },
    "invalidGoalIntent": {
      "code": "invalid_goal_intent",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidHistoryConfiguration": {
      "code": "invalid_history_configuration",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidHistoryLocation": {
      "code": "invalid_history_location",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidHistoryQuery": {
      "code": "invalid_history_query",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidHistoryReference": {
      "code": "invalid_history_reference",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidHistoryReferences": {
      "code": "invalid_history_references",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidHistoryRequest": {
      "code": "invalid_history_request",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidHistoryResolution": {
      "code": "invalid_history_resolution",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidHost": {
      "code": "invalid_host",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidImageId": {
      "code": "invalid_image_id",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "session-image-invalid",
      },
    },
    "invalidImageRequest": {
      "code": "invalid_image_request",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidImageResponse": {
      "code": "invalid_image_response",
      "retry": "unclassified",
      "http": {
        "status": 502,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidInput": {
      "code": "invalid_input",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "invalid-request",
        "additional": {
          "providerValidation": {
            "kind": "result",
            "field": "error",
            "reason": "invalid_input",
            "status": 400,
          },
        },
      },
    },
    "invalidJson": {
      "code": "invalid_json",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidLanAddress": {
      "code": "invalid_lan_address",
      "retry": "unclassified",
      "ipc": {
        "kind": "none",
      },
    },
    "invalidLeadDelegation": {
      "code": "invalid-lead-delegation",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "invalid-lead-delegation",
      },
    },
    "invalidLeadRequest": {
      "code": "invalid-lead-request",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "invalid-lead-request",
      },
    },
    "invalidLeadTurnLimit": {
      "code": "invalid-lead-turn-limit",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "invalid-lead-turn-limit",
      },
    },
    "invalidLeadWorkspaces": {
      "code": "invalid-lead-workspaces",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "invalid-lead-workspaces",
      },
    },
    "invalidLimit": {
      "code": "invalid_limit",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidNotificationPolicy": {
      "code": "invalid_notification_policy",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidNotificationQuery": {
      "code": "invalid_notification_query",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidObjective": {
      "code": "invalid_objective",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidOperation": {
      "code": "invalid_operation",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidOrigin": {
      "code": "invalid_origin",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidPairingCode": {
      "code": "invalid_pairing_code",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidPath": {
      "code": "invalid_path",
      "retry": "unclassified",
      "http": {
        "status": 400,
        "overrides": {
          "invalidRemoteRequestTarget": 403,
        },
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidPolicy": {
      "code": "invalid-policy",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "invalid-policy",
      },
    },
    "invalidPreflight": {
      "code": "invalid_preflight",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidPushSubscription": {
      "code": "invalid_push_subscription",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidQueueOrder": {
      "code": "invalid_queue_order",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidReadStateRequest": {
      "code": "invalid_read_state_request",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidRequest": {
      "code": "invalid_request",
      "retry": "unclassified",
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "invalid_request",
      },
    },
    "invalidRequestDetail": {
      "code": "invalid-request",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "invalid-request",
      },
    },
    "invalidRequestId": {
      "code": "invalid_request_id",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidResourceIds": {
      "code": "invalid_resource_ids",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidRestoreDefaults": {
      "code": "invalid_restore_defaults",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "invalid_restore_defaults",
      },
    },
    "invalidRevision": {
      "code": "invalid_revision",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidSavedConfiguration": {
      "code": "invalid_saved_configuration",
      "retry": "unclassified",
      "ipc": {
        "kind": "transport",
      },
    },
    "invalidSessionPinRequest": {
      "code": "invalid_session_pin_request",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidSubagentId": {
      "code": "invalid_subagent_id",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidText": {
      "code": "invalid_text",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "invalidTokenBudget": {
      "code": "invalid_token_budget",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "jsonRequired": {
      "code": "json_required",
      "retry": "unclassified",
      "http": {
        "status": 415,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "lanAddressUnavailable": {
      "code": "lan_address_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 503,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "leadClaudeTerminalDisconnected": {
      "code": "lead-claude-terminal-disconnected",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "lead-claude-terminal-disconnected",
      },
    },
    "leadExists": {
      "code": "lead-exists",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "lead-exists",
      },
    },
    "leadNotControllable": {
      "code": "lead-not-controllable",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "lead-not-controllable",
      },
    },
    "leadRequiresManagedClaude": {
      "code": "lead-requires-managed-claude",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "lead-requires-managed-claude",
      },
    },
    "leadToolsUnavailable": {
      "code": "lead-tools-unavailable",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "lead-tools-unavailable",
      },
    },
    "leadUnavailable": {
      "code": "lead-unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "lead-unavailable",
      },
    },
    "livePreviewCrossSite": {
      "code": "live_preview_cross_site",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "livePreviewDenied": {
      "code": "live_preview_denied",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "livePreviewExpired": {
      "code": "live_preview_expired",
      "retry": "unclassified",
      "http": {
        "status": 410,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "livePreviewInvalidHost": {
      "code": "live_preview_invalid_host",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "livePreviewMethodNotAllowed": {
      "code": "live_preview_method_not_allowed",
      "retry": "unclassified",
      "http": {
        "status": 405,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "livePreviewNotFound": {
      "code": "live_preview_not_found",
      "retry": "unclassified",
      "http": {
        "status": 404,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "livePreviewPortBlocked": {
      "code": "live_preview_port_blocked",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "livePreviewPortReserved": {
      "code": "live_preview_port_reserved",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "livePreviewRequestLimit": {
      "code": "live_preview_request_limit",
      "retry": "unclassified",
      "http": {
        "status": 429,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "livePreviewTicketLimit": {
      "code": "live_preview_ticket_limit",
      "retry": "unclassified",
      "http": {
        "status": 429,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "livePreviewUnreachable": {
      "code": "live_preview_unreachable",
      "retry": "unclassified",
      "http": {
        "status": 409,
        "overrides": {
          "previewProxyUnavailable": 502,
        },
      },
      "ipc": {
        "kind": "none",
      },
    },
    "livePreviewWorkerRequired": {
      "code": "live_preview_worker_required",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "liveSessionLimit": {
      "code": "live-session-limit",
      "retry": "unclassified",
      "ipc": {
        "kind": "none",
      },
    },
    "managedSessionLimit": {
      "code": "managed-session-limit",
      "retry": "unclassified",
      "ipc": {
        "kind": "none",
      },
    },
    "methodNotAllowed": {
      "code": "method_not_allowed",
      "retry": "unclassified",
      "http": {
        "status": 405,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "missingPrompt": {
      "code": "missing_prompt",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "modelImagesUnsupported": {
      "code": "model-images-unsupported",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "model-images-unsupported",
      },
    },
    "nativeEffortUnconfirmed": {
      "code": "native-effort-unconfirmed",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "native-effort-unconfirmed",
      },
    },
    "nativeModelUnconfirmed": {
      "code": "native-model-unconfirmed",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "native-model-unconfirmed",
      },
    },
    "nativePolicyApprovalPolicyMismatch": {
      "code": "native-policy-approval-policy-mismatch",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "native-policy-approval-policy-mismatch",
      },
    },
    "nativePolicyApprovalsReviewerMismatch": {
      "code": "native-policy-approvals-reviewer-mismatch",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "native-policy-approvals-reviewer-mismatch",
      },
    },
    "nativePolicyCwdMismatch": {
      "code": "native-policy-cwd-mismatch",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "native-policy-cwd-mismatch",
      },
    },
    "nativePolicyFullAccessRequired": {
      "code": "native-policy-full-access-required",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "native-policy-full-access-required",
      },
    },
    "nativePolicySandboxNetworkMismatch": {
      "code": "native-policy-sandbox-network-mismatch",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "native-policy-sandbox-network-mismatch",
      },
    },
    "nativePolicySandboxReadAccessMismatch": {
      "code": "native-policy-sandbox-read-access-mismatch",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "native-policy-sandbox-read-access-mismatch",
      },
    },
    "nativePolicySandboxSlashTmpMismatch": {
      "code": "native-policy-sandbox-slash-tmp-mismatch",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "native-policy-sandbox-slash-tmp-mismatch",
      },
    },
    "nativePolicySandboxTmpdirMismatch": {
      "code": "native-policy-sandbox-tmpdir-mismatch",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "native-policy-sandbox-tmpdir-mismatch",
      },
    },
    "nativePolicySandboxTypeMismatch": {
      "code": "native-policy-sandbox-type-mismatch",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "native-policy-sandbox-type-mismatch",
      },
    },
    "nativePolicySandboxWritableRootsMismatch": {
      "code": "native-policy-sandbox-writable-roots-mismatch",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "native-policy-sandbox-writable-roots-mismatch",
      },
    },
    "nativePolicyUnconfirmed": {
      "code": "native-policy-unconfirmed",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "native-policy-unconfirmed",
      },
    },
    "notFound": {
      "code": "not_found",
      "retry": "unclassified",
      "http": {
        "status": 404,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "notificationPolicyUnavailable": {
      "code": "notification_policy_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 503,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "operationBusy": {
      "code": "operation_busy",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "operation_busy",
      },
    },
    "operationUnavailable": {
      "code": "operation_unavailable",
      "retry": "unclassified",
      "ipc": {
        "kind": "none",
      },
    },
    "orchestrationUnavailable": {
      "code": "orchestration-unavailable",
      "retry": "after-backoff",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "orchestration-unavailable",
      },
    },
    "outcomeGracePeriod": {
      "code": "outcome_grace_period",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "outcomeUnknown": {
      "code": "outcome_unknown",
      "retry": "unclassified",
      "http": {
        "status": 409,
        "overrides": {
          "runtimeResponseUnconfirmed": 502,
          "runtimeResponseTimedOut": 504,
        },
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "outcome_unknown",
      },
    },
    "ownerOpenedElsewhere": {
      "code": "owner-opened-elsewhere",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "owner-opened-elsewhere",
      },
    },
    "ownerRequired": {
      "code": "owner_required",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "pauseOriginalGoalBeforeHandoff": {
      "code": "pause-original-goal-before-handoff",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "pause-original-goal-before-handoff",
      },
    },
    "pendingLimit": {
      "code": "pending_limit",
      "retry": "unclassified",
      "http": {
        "status": 429,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "pendingStorageUnavailable": {
      "code": "pending_storage_unavailable",
      "retry": "unclassified",
      "ipc": {
        "kind": "none",
      },
    },
    "permissionDenied": {
      "code": "permission_denied",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "permission_denied",
      },
    },
    "platformUnsupported": {
      "code": "platform-unsupported",
      "retry": "never",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "platform-unsupported",
      },
    },
    "portInUse": {
      "code": "port_in_use",
      "retry": "unclassified",
      "ipc": {
        "kind": "transport",
      },
    },
    "previewFailed": {
      "code": "preview_failed",
      "retry": "unclassified",
      "http": {
        "status": 500,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "previewUnavailable": {
      "code": "preview_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 503,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "projectAgentFailed": {
      "code": "project_agent_failed",
      "retry": "unclassified",
      "http": {
        "status": 500,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "promptTooLarge": {
      "code": "prompt_too_large",
      "retry": "unclassified",
      "http": {
        "status": 413,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "providerControlNotAllowed": {
      "code": "provider_control_not_allowed",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "pushActionUnavailable": {
      "code": "push_action_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "pushUnavailable": {
      "code": "push_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "questionUnavailable": {
      "code": "question_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "queueAttachmentsEditUnsupported": {
      "code": "queue_attachments_edit_unsupported",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "queueItemUnavailable": {
      "code": "queue_item_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "queueRequiresRunningTurn": {
      "code": "queue_requires_running_turn",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "queueTooLarge": {
      "code": "queue_too_large",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "queueFull": {
      "code": "queue-full",
      "retry": "after-backoff",
      "ipc": {
        "kind": "none",
      },
    },
    "rateLimited": {
      "code": "rate_limited",
      "retry": "unclassified",
      "http": {
        "status": 429,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "readStateConflict": {
      "code": "read_state_conflict",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "read-state-conflict",
      },
    },
    "readStateConflictDetail": {
      "code": "read-state-conflict",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "read-state-conflict",
      },
    },
    "readStateUnavailable": {
      "code": "read_state_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 503,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "read-state-unavailable",
      },
    },
    "readStateUnavailableDetail": {
      "code": "read-state-unavailable",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "read-state-unavailable",
      },
    },
    "readStateUnsupported": {
      "code": "read_state_unsupported",
      "retry": "unclassified",
      "http": {
        "status": 404,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "read-state-unsupported",
      },
    },
    "readStateUnsupportedDetail": {
      "code": "read-state-unsupported",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "read-state-unsupported",
      },
    },
    "receiptUnavailable": {
      "code": "receipt_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 503,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "relayUnavailable": {
      "code": "relay_unavailable",
      "retry": "unclassified",
      "ipc": {
        "kind": "transport",
      },
    },
    "requestNotAuthorized": {
      "code": "request_not_authorized",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "remoteEnableUnavailable": {
      "code": "remote_enable_unavailable",
      "retry": "unclassified",
      "ipc": {
        "kind": "transport",
      },
    },
    "remoteEnvironmentNotSupported": {
      "code": "remote-environment-not-supported",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "remote-environment-not-supported",
      },
    },
    "requestConflict": {
      "code": "request_conflict",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "requestFailed": {
      "code": "request_failed",
      "retry": "unclassified",
      "http": {
        "status": 500,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
      },
    },
    "requestIdConflict": {
      "code": "request_id_conflict",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "resourcesNotSupported": {
      "code": "resources_not_supported",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "resourceUnavailable": {
      "code": "resource_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "responseTooLarge": {
      "code": "response_too_large",
      "retry": "unclassified",
      "http": {
        "status": 413,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "rpcApplicationFailure": {
      "code": "rpc_application_failure",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
      },
    },
    "rpcIncompatibleProtocol": {
      "code": "rpc_incompatible_protocol",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32001,
      },
    },
    "rpcInvalidParams": {
      "code": "rpc_invalid_params",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32602,
      },
    },
    "rpcInvalidRequest": {
      "code": "rpc_invalid_request",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32600,
      },
    },
    "rpcMethodNotFound": {
      "code": "rpc_method_not_found",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32601,
      },
    },
    "sessionBusy": {
      "code": "session-busy",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "session-busy",
      },
    },
    "sessionCompacting": {
      "code": "session-compacting",
      "retry": "after-backoff",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "session-compacting",
      },
    },
    "sessionControlNotAllowed": {
      "code": "session_control_not_allowed",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "sessionImageChanged": {
      "code": "session-image-changed",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "session-image-changed",
      },
    },
    "sessionImageInvalid": {
      "code": "session-image-invalid",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "session-image-invalid",
      },
    },
    "sessionImageTooLarge": {
      "code": "session-image-too-large",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "session-image-too-large",
      },
    },
    "sessionImageUnavailable": {
      "code": "session-image-unavailable",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "session-image-unavailable",
      },
    },
    "sessionImageUnsupported": {
      "code": "session-image-unsupported",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "session-image-unsupported",
      },
    },
    "sessionIndexStale": {
      "code": "session_index_stale",
      "retry": "unclassified",
      "ipc": {
        "kind": "none",
      },
    },
    "sessionIndexStaleDetail": {
      "code": "session-index-stale",
      "retry": "unclassified",
      "ipc": {
        "kind": "transport",
      },
    },
    "sessionIsAProjectAgent": {
      "code": "session-is-a-project-agent",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "session-is-a-project-agent",
      },
    },
    "sessionIsAWorker": {
      "code": "session-is-a-worker",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "session-is-a-worker",
      },
    },
    "sessionManagedByAnotherRuntime": {
      "code": "session-managed-by-another-runtime",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "session-managed-by-another-runtime",
      },
    },
    "sessionNotFound": {
      "code": "session_not_found",
      "retry": "unclassified",
      "http": {
        "status": 404,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "sessionOpenElsewhere": {
      "code": "session-open-elsewhere",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "session-open-elsewhere",
      },
    },
    "sessionPinBusy": {
      "code": "session_pin_busy",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "sessionPinUnavailable": {
      "code": "session_pin_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "sessionReleased": {
      "code": "session-released",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "session-released",
      },
    },
    "sessionUnknown": {
      "code": "session_unknown",
      "retry": "unclassified",
      "ipc": {
        "kind": "transport",
      },
    },
    "sessionWorkspaceMismatch": {
      "code": "session_workspace_mismatch",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "sessionWorkspaceUnavailable": {
      "code": "session-workspace-unavailable",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "session-workspace-unavailable",
      },
    },
    "settingUnavailable": {
      "code": "setting_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "setting_unavailable",
      },
    },
    "staleBoot": {
      "code": "stale_boot",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "staleClaudeRevision": {
      "code": "stale-Claude-revision",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "stale-Claude-revision",
      },
    },
    "sourcePartial": {
      "code": "source-partial",
      "retry": "after-backoff",
      "ipc": {
        "kind": "none",
      },
    },
    "sourceUnavailable": {
      "code": "source-unavailable",
      "retry": "after-backoff",
      "ipc": {
        "kind": "none",
      },
    },
    "staleCursor": {
      "code": "stale_cursor",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "TRANSCRIPT_CURSOR_STALE",
      },
    },
    "staleState": {
      "code": "stale_state",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "stale_state",
      },
    },
    "stateUnavailable": {
      "code": "state_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "streamCursorTooLarge": {
      "code": "stream_cursor_too_large",
      "retry": "unclassified",
      "ipc": {
        "kind": "none",
      },
    },
    "streamLimit": {
      "code": "stream_limit",
      "retry": "unclassified",
      "http": {
        "status": 429,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "streamTooLarge": {
      "code": "stream_too_large",
      "retry": "unclassified",
      "ipc": {
        "kind": "none",
      },
    },
    "streamUnavailable": {
      "code": "stream_unavailable",
      "retry": "unclassified",
      "ipc": {
        "kind": "none",
      },
    },
    "subagentUnavailable": {
      "code": "subagent_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 404,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "subagent-unavailable",
      },
    },
    "subagentUnavailableDetail": {
      "code": "subagent-unavailable",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "subagent-unavailable",
      },
    },
    "tooManyInputItems": {
      "code": "too_many_input_items",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "transcriptCursorInvalid": {
      "code": "TRANSCRIPT_CURSOR_INVALID",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "TRANSCRIPT_CURSOR_INVALID",
      },
    },
    "transcriptCursorStale": {
      "code": "TRANSCRIPT_CURSOR_STALE",
      "retry": "unclassified",
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "TRANSCRIPT_CURSOR_STALE",
      },
    },
    "turnUnavailable": {
      "code": "turn_unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "unpaired": {
      "code": "unpaired",
      "retry": "unclassified",
      "http": {
        "status": 401,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "unsupportedCodexCliVersion": {
      "code": "unsupported-codex-cli-version",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "unsupported-codex-cli-version",
      },
    },
    "unsupportedEffort": {
      "code": "unsupported_effort",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "unsupported_effort",
      },
    },
    "unsupportedEffortDetail": {
      "code": "unsupported-effort",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "unsupported-effort",
      },
    },
    "unsupportedHost": {
      "code": "unsupported_host",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "unsupportedMode": {
      "code": "unsupported_mode",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "unsupported_mode",
      },
    },
    "unsupportedModel": {
      "code": "unsupported_model",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "unsupported_model",
      },
    },
    "unsupportedModelDetail": {
      "code": "unsupported-model",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "unsupported-model",
      },
    },
    "unsupportedPermissionMode": {
      "code": "unsupported_permission_mode",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "unsupported_permission_mode",
      },
    },
    "unsupportedPolicy": {
      "code": "unsupported_policy",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "unsupported_policy",
      },
    },
    "unsupportedProviderResources": {
      "code": "unsupported_provider_resources",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "none",
      },
    },
    "unsupportedServiceTier": {
      "code": "unsupported_service_tier",
      "retry": "unclassified",
      "http": {
        "status": 400,
      },
      "ipc": {
        "kind": "result",
        "field": "error",
        "reason": "unsupported_service_tier",
      },
    },
    "unsupportedServiceTierDetail": {
      "code": "unsupported-service-tier",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "unsupported-service-tier",
      },
    },
    "unverifiedInstallation": {
      "code": "unverified-installation",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "unverified-installation",
      },
    },
    "uploadFailed": {
      "code": "upload_failed",
      "retry": "unclassified",
      "ipc": {
        "kind": "none",
      },
    },
    "webBusy": {
      "code": "web-busy",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "web-busy",
      },
    },
    "webServerError": {
      "code": "web_server_error",
      "retry": "unclassified",
      "ipc": {
        "kind": "transport",
      },
    },
    "webStartFailed": {
      "code": "web_start_failed",
      "retry": "unclassified",
      "ipc": {
        "kind": "transport",
      },
    },
    "webStateSaveFailed": {
      "code": "web_state_save_failed",
      "retry": "unclassified",
      "ipc": {
        "kind": "transport",
      },
    },
    "workerAgentUnsupported": {
      "code": "worker-agent-unsupported",
      "retry": "never",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "worker-agent-unsupported",
      },
    },
    "workerAssignmentChanged": {
      "code": "worker-assignment-changed",
      "retry": "after-refresh",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "worker-assignment-changed",
      },
    },
    "workerLimitReached": {
      "code": "worker-limit-reached",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "worker-limit-reached",
      },
    },
    "workerNotAssigned": {
      "code": "worker-not-assigned",
      "retry": "after-refresh",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "worker-not-assigned",
      },
    },
    "workerNotControllable": {
      "code": "worker-not-controllable",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "worker-not-controllable",
      },
    },
    "workerNotRunning": {
      "code": "worker-not-running",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "worker-not-running",
      },
    },
    "workerOutsideProject": {
      "code": "worker-outside-project",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "worker-outside-project",
      },
    },
    "workerProbeFailed": {
      "code": "worker-probe-failed",
      "retry": "after-backoff",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "worker-probe-failed",
      },
    },
    "workerTerminalDisconnected": {
      "code": "worker-terminal-disconnected",
      "retry": "after-user-action",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "worker-terminal-disconnected",
      },
    },
    "workerUnavailable": {
      "code": "worker-unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "worker-unavailable",
        "additional": {
          "actionRefusal": {
            "kind": "result",
            "field": "reason",
            "reason": "worker-unavailable",
          },
        },
      },
    },
    "workspaceNotAuthorized": {
      "code": "workspace_not_authorized",
      "retry": "unclassified",
      "http": {
        "status": 403,
      },
      "ipc": {
        "kind": "rpc",
        "rpcCode": -32000,
        "detail": "workspace_not_authorized",
      },
    },
    "workspaceUnavailable": {
      "code": "workspace-unavailable",
      "retry": "unclassified",
      "http": {
        "status": 409,
      },
      "ipc": {
        "kind": "result",
        "field": "reason",
        "reason": "workspace-unavailable",
      },
    },
  };
}
