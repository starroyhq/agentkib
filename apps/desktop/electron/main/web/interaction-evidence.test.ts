import {
  sessionProviderCapabilities,
  sessionProviderDeclaration,
} from "@agentkib/runtime-protocol";
import { describe, expect, it } from "vitest";
import { interactionEvidence } from "@agentkib/backend/session-interaction-evidence";

const workspace = "/work/project";

describe("native interaction evidence", () => {
  it("registers the interaction kinds exposed by each provider", () => {
    for (const agent of ["codex", "claude-code", "deepseek-harness"])
      expect(sessionProviderDeclaration(agent)?.pendingInteractions).toEqual({
        approval: true,
        question: true,
      });
    for (const agent of ["devin", "antigravity"])
      expect(sessionProviderCapabilities(agent)?.pendingInteractions).toEqual({ approval: true });
    expect(sessionProviderDeclaration("unknown")).toBeUndefined();
  });

  it("shows Codex's actual command and verbatim reason, and does not trust the reason for risk", () => {
    const summary = "Just a unit test. ";
    const evidence = interactionEvidence("codex", "approval", {
      method: "item/commandExecution/requestApproval",
      cwd: workspace,
      command: "git push",
      requestContext: { reason: summary, proposedExecpolicyAmendment: ["git", "push"] },
    });
    expect(evidence).toMatchObject({
      summary,
      command: "git push",
      cwd: workspace,
      parameters: { proposedExecpolicyAmendment: ["git", "push"] },
      riskInput: { kind: "command", command: "git push", cwd: workspace },
    });
  });

  it("preserves Codex deletion, move, and network evidence", () => {
    const changes = [
      { path: "/work/project/first", kind: { type: "update", movePath: "/work/project/second" } },
      { path: "/work/project/third", kind: { type: "delete" } },
    ];
    expect(
      interactionEvidence("codex", "approval", {
        method: "item/fileChange/requestApproval",
        changes,
      }),
    ).toMatchObject({
      parameters: { changes },
      riskInput: {
        kind: "delete",
        paths: ["/work/project/first", "/work/project/second", "/work/project/third"],
      },
    });
    const networkApprovalContext = { host: "example.test", protocol: "https" };
    expect(
      interactionEvidence("codex", "approval", {
        method: "item/commandExecution/requestApproval",
        command: "git status",
        requestContext: { networkApprovalContext },
      }),
    ).toMatchObject({
      parameters: { networkApprovalContext },
      riskInput: { kind: "network" },
    });
  });

  it("uses managed Claude tool arguments and the native blocked path", () => {
    const input = { file_path: "/work/project/notes.txt", old_string: "old", new_string: "new" };
    expect(
      interactionEvidence("claude-code", "approval", {
        toolName: "Edit",
        input,
        context: { decisionReason: "Claude asked to edit the file", blockedPath: "/other" },
      }),
    ).toMatchObject({
      summary: "Claude asked to edit the file",
      toolName: "Edit",
      parameters: input,
      riskInput: { kind: "write", paths: ["/work/project/notes.txt", "/other"] },
    });
    expect(
      interactionEvidence("claude-code", "approval", {
        toolName: "Bash",
        input: { command: "git status", dangerouslyDisableSandbox: true },
      }).riskInput.kind,
    ).toBe("unknown");
  });

  it("uses native DSH read arguments and treats permission-style questions as unresolved risk", () => {
    expect(
      interactionEvidence("deepseek-harness", "approval", {
        toolName: "read_file",
        input: { path: "/work/project/notes.txt" },
        command: { reason: "Read the fixture." },
      }),
    ).toMatchObject({
      summary: "Read the fixture.",
      parameters: { path: "/work/project/notes.txt" },
      riskInput: { kind: "read", paths: ["/work/project/notes.txt"] },
    });
    const questions = [{ question: "May I run it?", options: [{ label: "Always" }] }];
    expect(
      interactionEvidence("deepseek-harness", "question", { questions, permissionIntent: true }),
    ).toMatchObject({
      summary: "May I run it?",
      parameters: questions,
      riskInput: { kind: "unknown" },
    });
  });

  it("projects an ACP command without inventing a description from the fallback title", () => {
    const toolCall = {
      title: "Devin synthesized fallback",
      kind: "execute",
      rawInput: { command: "git status", cwd: workspace },
    };
    const evidence = interactionEvidence("devin", "approval", { toolCall });
    expect(evidence.summary).toBeUndefined();
    expect(evidence).toMatchObject({
      command: "git status",
      parameters: toolCall.rawInput,
      riskInput: { kind: "command", command: "git status", cwd: workspace },
    });
    expect(
      interactionEvidence("devin", "approval", {
        toolCall: { ...toolCall, rawInput: { ...toolCall.rawInput, args: ["push"] } },
      }).riskInput.kind,
    ).toBe("unknown");
  });

  it("keeps Antigravity's actual diff, and does not mistake a configured MCP call for a shell", () => {
    const content = [{ type: "diff", path: "/work/project/new", oldText: null, newText: "new" }];
    expect(
      interactionEvidence("antigravity", "approval", {
        agentDescription: "Generate the changes",
        toolCall: { kind: "edit", content },
      }),
    ).toMatchObject({
      summary: "Generate the changes",
      parameters: { content },
      riskInput: { kind: "write", paths: ["/work/project/new"] },
    });
    expect(
      interactionEvidence("antigravity", "approval", {
        toolCall: {
          name: "call_mcp_tool",
          kind: "execute",
          rawInput: { command: "git status" },
        },
      }).riskInput.kind,
    ).toBe("unknown");
  });

  it("keeps the question text and structured choices for a plain question", () => {
    const questions = [
      {
        id: "question",
        question: "Which destination?",
        options: [{ label: "Here" }],
        multiSelect: false,
      },
    ];
    expect(interactionEvidence("codex", "question", { questions })).toMatchObject({
      summary: "Which destination?",
      parameters: questions,
      riskInput: { kind: "question" },
    });
  });
});
