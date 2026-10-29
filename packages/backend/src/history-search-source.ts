import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { Commands } from "./commands";
import { SessionReaders } from "./session-readers";
import { sessionIdentity, type SessionStore, type NativeSession } from "./session-store";
import { sanitizeHandoffExport, sanitizeSessionText } from "./session-handoff";
import { GrokSessions } from "./grok-sessions";
import { CodexSessions } from "./codex-sessions";
import { ClaudeSessions } from "./claude-sessions";
import { HermesSessions } from "./hermes-sessions";
import { OpenClawSessions } from "./openclaw-sessions";
import {
  OpenClawSourceOwnershipError,
  verifyOpenClawSqliteOwnership,
} from "./openclaw-sqlite-sessions";
import { OpenCodeSessions } from "./opencode-sessions";
import { CursorSessions } from "./cursor-sessions";
import { CursorIdeSessions } from "./cursor-ide-sessions";
import { AntigravitySessions } from "./antigravity-sessions";
import { parseAntigravityReplay } from "./antigravity-replay";
import { stringifyAcpJson } from "./acp-json";
import { canonicalize, pathIdentity } from "./paths";
import { belongsToWorkspace, jsonTimestamp, stableNativeRef } from "./session-history";
import { userHome } from "./mcp-config-read";
import type { SessionDocument } from "./session-model";
import { historySourceIdentity } from "./history-search-source-identity";
import { readJsonlSearchSource } from "./history-search-source-jsonl";
import { readHermesSearchSource, readOpenClawSearchSource } from "./history-search-source-sql";
import { emitMessage, object, readSourceSnapshot } from "./history-search-source-records";
import type {
  HistorySourceInput,
  HistorySourceRecord,
  HistorySourceResult,
  HistorySourceSink,
  OpenClawHistorySourceBinding,
} from "./history-search-source-types";
export type {
  HistorySourceInput,
  HistorySourceRecord,
  HistorySourceResult,
} from "./history-search-source-types";

export interface HistorySourceOptions {
  commands?: Commands;
  signal?: AbortSignal;
  checkpoint?: () => void;
}

function verifyOpenClawSearchBinding(
  input: HistorySourceInput,
  binding: OpenClawHistorySourceBinding,
): void {
  if (
    !binding.agentId ||
    [".", ".."].includes(binding.agentId) ||
    path.basename(binding.agentId) !== binding.agentId ||
    sessionIdentity(
      input.identitySalt,
      "open-claw",
      stableNativeRef("openclaw-sqlite-v23", [
        binding.home,
        binding.agentId,
        binding.sessionId,
        binding.cwd,
      ]),
    ) !== input.sessionId
  )
    throw new Error("history-source-unavailable");
  if (new OpenClawSessions(input.environment).home() !== binding.home)
    throw new OpenClawSourceOwnershipError(
      "OpenClaw source directory changed while reading history",
    );
  verifyOpenClawSqliteOwnership({
    file: path.join(binding.home, "agents", binding.agentId, "agent", "openclaw-agent.sqlite"),
    agentId: binding.agentId,
    id: binding.sessionId,
    cwd: binding.cwd,
  });
}

/** Callers stage emitted records and publish them only after this function successfully settles. */
export async function readHistorySearchSource(
  input: HistorySourceInput,
  onRecord: (record: HistorySourceRecord) => Promise<void> | void,
  options: HistorySourceOptions = {},
): Promise<HistorySourceResult> {
  const commands = options.commands ?? new Commands();
  const check = () => {
    options.signal?.throwIfAborted();
    options.checkpoint?.();
  };
  check();
  if (
    input.summary.id !== input.sessionId ||
    input.summary.availability !== "readable" ||
    ["auxiliary", "execution"].includes(input.summary.origin)
  )
    throw new Error("history-source-unavailable");
  const store = {
    get: (id: string) => (id === input.sessionId ? input.summary : null),
    workspacePath: (id: string) => {
      if (id !== input.summary.workspace_id) throw new Error("history-source-owner-changed");
      return input.workspacePath;
    },
    identitySalt: () => input.identitySalt,
    id: (agent: Parameters<SessionStore["id"]>[0], ref: string) =>
      sessionIdentity(input.identitySalt, agent, ref),
  };
  const bridge = {
    profiles: (workspace: string) => {
      if (workspace !== input.workspacePath) throw new Error("history-source-owner-changed");
      return input.profiles;
    },
  };
  const readers = new SessionReaders(store, commands, input.environment, bridge);
  const hash = createHash("sha256");
  const limitations = new Set<string>();
  const seen = new Map<string, string>();
  const toolNames = new Map<string, string>();
  let count = 0,
    bytes = 0;
  let openClawBinding: OpenClawHistorySourceBinding | undefined = input.openClawBinding;
  // Limits describe omitted records; they never turn clipped text into a complete record.
  const sink: HistorySourceSink = {
    checkpoint: check,
    fingerprint: (value) => {
      hash
        .update(String(typeof value === "string" ? Buffer.byteLength(value) : value.byteLength))
        .update(":")
        .update(value);
    },
    limit: (code) => {
      limitations.add(code);
    },
    emit: async (record) => {
      check();
      const size = Buffer.byteLength(record.content);
      if (size > 16 * 1024 * 1024) {
        limitations.add("source-record-limit");
        return;
      }
      if (count >= 100_000 || bytes + size > 256 * 1024 * 1024) {
        limitations.add("source-byte-limit");
        return;
      }
      bytes += size;
      const recordId = createHash("sha256")
        .update(input.sessionId)
        .update("\0")
        .update(record.recordId)
        .update("\0")
        .update(record.kind)
        .digest("hex");
      const originalHash = createHash("sha256").update(record.content).digest("hex");
      if (seen.has(recordId)) {
        if (seen.get(recordId) !== originalHash) limitations.add("duplicate-record-identity");
        return;
      }
      seen.set(recordId, originalHash);
      const content = sanitizeHistorySourceText(record.content);
      if (!content.trim()) return;
      const call = record.recordId.replace(/:(?:input|output)$/, ""),
        name = record.toolName;
      if (name) toolNames.set(call, name);
      const toolName = name ?? toolNames.get(call) ?? null;
      sink.fingerprint(JSON.stringify({ ...record, content: originalHash }));
      await onRecord({
        ...record,
        recordId,
        ordinal: count++,
        content,
        toolName: toolName ? sanitizeSessionText(toolName, { value: 0 }) : null,
      });
      check();
    },
  };
  const abort = () => {
    if (!options.commands) commands.close();
    readers.close();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const verifyNative = (native: NativeSession) => {
      // The index keeps AgentKib's own `--print` Claude runs as conversations. A fresh read
      // still sees their `sdk-cli` entrypoint, so only that indexed decision admits them.
      const managedClaude =
        native.agent === "claude-code" &&
        native.origin === "execution" &&
        input.summary.origin === "interactive";
      if (
        sessionIdentity(input.identitySalt, native.agent, native.native_ref) !== input.sessionId ||
        native.sidechain ||
        native.origin === "auxiliary" ||
        (native.origin === "execution" && !managedClaude)
      )
        throw new Error("history-source-owner-changed");
      if (native.availability !== "readable") throw new Error("history-source-unavailable");
    };
    const resolveOwned = async () => {
      check();
      if (input.summary.agent === "open-claw" && openClawBinding) {
        try {
          verifyOpenClawSearchBinding(input, openClawBinding);
        } catch (error) {
          check();
          // Keep confirmed changes outside discovery's best-effort missing-source catch.
          if (error instanceof OpenClawSourceOwnershipError)
            throw new Error("history-source-owner-changed", { cause: error });
          throw error;
        }
        check();
      }
      try {
        const value = await readers.resolve(input.sessionId);
        check();
        verifyNative(value.native);
        return value;
      } catch (error) {
        check();
        if (
          error instanceof Error &&
          error.message === "Conversation transcript is no longer available"
        ) {
          // Missing/offline history retains its last-good cache. A source still
          // present under a different native workspace must instead be withdrawn.
          let lookup: { cwd: string | null; session: NativeSession } | undefined;
          let cursorWorkspaces: string[] | undefined;
          try {
            const matches = (value: { session: NativeSession }) =>
              sessionIdentity(input.identitySalt, value.session.agent, value.session.native_ref) ===
              input.sessionId;
            switch (input.summary.agent) {
              case "codex":
                lookup = new CodexSessions(input.environment)
                  .list(null, {
                    matches: (ref) =>
                      sessionIdentity(input.identitySalt, "codex", ref) === input.sessionId,
                  })
                  .sessions.find(matches);
                break;
              case "claude-code":
                lookup = new ClaudeSessions(input.environment).list(null).sessions.find(matches);
                break;
              case "hermes":
                lookup = new HermesSessions(input.environment).list(null).sessions.find(matches);
                break;
              case "grok-build":
                lookup = new GrokSessions(input.environment).list(null).sessions.find(matches);
                break;
              case "open-claw":
                lookup = new OpenClawSessions(input.environment).list(null).sessions.find(matches);
                break;
              case "cursor": {
                // The CLI root can move while its path-based native identity stays stable.
                // Match only that identity before opening a store; an unrelated profile or
                // unreadable root cannot establish revocation of this cached source.
                const { store } = new CursorSessions(input.environment).resolveByIdentity(
                  (ref) => sessionIdentity(input.identitySalt, "cursor", ref) === input.sessionId,
                );
                try {
                  cursorWorkspaces = store.workspaces();
                } finally {
                  store.close();
                }
                break;
              }
            }
          } catch {
            check();
          }
          if (
            cursorWorkspaces &&
            !cursorWorkspaces.some((cwd) =>
              belongsToWorkspace(cwd, input.workspacePath, userHome(input.environment)),
            )
          )
            throw new Error("history-source-owner-changed", { cause: error });
          if (lookup) {
            if (
              lookup.cwd !== null &&
              !belongsToWorkspace(lookup.cwd, input.workspacePath, userHome(input.environment))
            )
              throw new Error("history-source-owner-changed", { cause: error });
            verifyNative(lookup.session);
          }
          throw new Error("history-source-unavailable", { cause: error });
        }
        throw error;
      }
    };
    const resolved = await resolveOwned();
    const nativeEvidence = (native: NativeSession) =>
      JSON.stringify([
        native.agent,
        native.native_ref,
        native.title,
        native.origin,
        native.sidechain,
        native.availability,
      ]);
    const originalNative = nativeEvidence(resolved.native);
    const verifyLookup = (value: { cwd: string | null; session: NativeSession }) => {
      if (value.cwd === null) throw new Error("history-source-unavailable");
      if (!belongsToWorkspace(value.cwd, resolved.workspace, userHome(input.environment)))
        throw new Error("history-source-owner-changed");
      verifyNative(value.session);
      if (nativeEvidence(value.session) !== originalNative)
        throw new Error("history-source-changed");
    };
    sink.fingerprint(historySourceIdentity(input, originalNative, resolved));
    const { native, workspace, transcript } = resolved;
    switch (native.agent) {
      case "codex":
      case "claude-code":
        if (!transcript) throw new Error("history-source-unavailable");
        await readJsonlSearchSource(transcript, native.agent, sink);
        break;
      case "grok-build": {
        const source = new GrokSessions(input.environment).resolve(native.native_ref);
        verifyLookup(source);
        await readJsonlSearchSource(source.transcript, native.agent, sink);
        break;
      }
      case "hermes": {
        const lookup = new HermesSessions(input.environment).resolve(native.native_ref);
        verifyLookup(lookup);
        const { source } = lookup;
        if (source.type === "sqlite")
          await readHermesSearchSource(source, sink, workspace, userHome(input.environment));
        else await readJsonlSearchSource(source.path, native.agent, sink);
        break;
      }
      case "open-claw": {
        const source = new OpenClawSessions(input.environment).resolve(native.native_ref);
        verifyLookup(source);
        if (source.sqlite) {
          await readOpenClawSearchSource(source.sqlite, sink);
          openClawBinding = {
            home: new OpenClawSessions(input.environment).home(),
            agentId: source.sqlite.agentId,
            sessionId: source.sqlite.id,
            cwd: source.sqlite.cwd,
          };
        } else await readJsonlSearchSource(source.transcript, native.agent, sink);
        break;
      }
      case "opencode": {
        const snapshot = await readSourceSnapshot(sink, () =>
          new OpenCodeSessions(commands, input.environment).searchSnapshot(
            workspace,
            native.native_ref,
          ),
        );
        const info = object(snapshot.info);
        if (
          (typeof info.id === "string" && info.id !== native.native_ref) ||
          (typeof info.directory === "string" &&
            pathIdentity(canonicalize(info.directory)) !== pathIdentity(canonicalize(workspace)))
        )
          throw new Error("history-source-owner-changed");
        sink.fingerprint(stringifyAcpJson(snapshot));
        for (const message of snapshot.messages) {
          check();
          const content: unknown[] = [];
          for (const raw of message.parts) {
            const part = object(raw);
            if (part.type === "tool") {
              const state = object(part.state);
              content.push({
                type: "tool_use",
                id: part.callID,
                name: part.tool,
                input: state.input,
              });
              if (["completed", "error", "failed"].includes(String(state.status)))
                content.push({
                  type: "tool_result",
                  tool_use_id: part.callID,
                  name: part.tool,
                  content: state.output ?? state.error ?? state.message ?? "",
                });
            } else content.push(raw);
          }
          const created = message.info.time?.created;
          await emitMessage(
            {
              role: message.info.role,
              content,
              timestamp: created == null ? null : Number(created),
            },
            `opencode:${message.info.id}`,
            sink,
          );
        }
        break;
      }
      case "antigravity": {
        const provider = new AntigravitySessions(input.environment);
        const cancel = () => provider.close();
        options.signal?.addEventListener("abort", cancel, { once: true });
        try {
          const deadline = performance.now() + 15_000;
          const snapshot = await readSourceSnapshot(sink, () =>
            provider.readReplay(native.native_ref, deadline),
          );
          if (pathIdentity(snapshot.session.workspace) !== pathIdentity(canonicalize(workspace)))
            throw new Error("history-source-owner-changed");
          sink.fingerprint(stringifyAcpJson(snapshot.updates));
          // Resource bodies are attachments, even when ACP exposes them as readable text.
          const updates = snapshot.updates.map((update) => {
            if (
              ["user_message_chunk", "agent_message_chunk"].includes(String(update.sessionUpdate))
            ) {
              const content = object(update.content);
              // Replay groups unknown message blocks with ordinary attachment losses.
              // Only unrecognized body structures reduce the searchable text coverage.
              if (
                typeof content.type === "string" &&
                ![
                  "text",
                  "image",
                  "audio",
                  "resource",
                  "resource_link",
                  "thinking",
                  "reasoning",
                  "redacted_thinking",
                ].includes(content.type)
              )
                sink.limit("unsupported-text-content");
            }
            if (
              !["tool_call", "tool_call_update"].includes(String(update.sessionUpdate)) ||
              !Array.isArray(update.content)
            )
              return update;
            return {
              ...update,
              content: update.content.filter((raw) => {
                const block = object(raw);
                return block.type !== "content" || object(block.content).type !== "resource";
              }),
            };
          });
          const parsed = await readSourceSnapshot(sink, () =>
            parseAntigravityReplay(updates, deadline),
          );
          if (parsed.losses.has("source-content-truncated")) sink.limit("unsupported-tool-content");
          await emitTurns(parsed.turns, sink);
        } finally {
          options.signal?.removeEventListener("abort", cancel);
          provider.close();
        }
        break;
      }
      case "cursor": {
        sink.limit("cursor-tools-unsupported");
        if (native.native_ref.startsWith("cursor-ide-v1-")) {
          const snapshot = await readSourceSnapshot(sink, () =>
            new CursorIdeSessions(bridge).searchSnapshot(native.native_ref, workspace),
          );
          sink.fingerprint(snapshot.rootId);
          await emitTurns(snapshot.turns, sink);
        } else {
          const { store: cursor } = new CursorSessions(input.environment).resolve(
            native.native_ref,
          );
          try {
            if (
              !cursor
                .workspaces()
                .some((cwd) => belongsToWorkspace(cwd, workspace, userHome(input.environment)))
            )
              throw new Error("history-source-owner-changed");
            sink.fingerprint(cursor.rootId);
            const snapshot = await readSourceSnapshot(sink, () => cursor.turns());
            await emitTurns(snapshot.turns, sink);
          } finally {
            cursor.close();
          }
        }
        break;
      }
      default:
        throw new Error("history-source-unsupported");
    }
    check();
    // Publishing and reference reads must not authorize a snapshot using only the
    // business directory cache. Recheck independent native ownership and labels.
    const current = await resolveOwned();
    if (
      pathIdentity(canonicalize(current.workspace)) !== pathIdentity(canonicalize(workspace)) ||
      current.transcript !== transcript
    )
      throw new Error("history-source-owner-changed");
    if (nativeEvidence(current.native) !== originalNative)
      throw new Error("history-source-changed");
    check();
    return {
      sourceRevision: hash.digest("hex"),
      recordCount: count,
      limitations: [...limitations].sort(),
      status: limitations.size ? "partial" : "ready",
      ...(openClawBinding ? { openClawBinding } : {}),
    };
  } catch (error) {
    check();
    if (input.summary.agent === "open-claw" && openClawBinding) {
      try {
        verifyOpenClawSearchBinding(input, openClawBinding);
      } catch (ownershipError) {
        check();
        // Discovery can fail after the earlier probe; replace failures only with
        // confirmed revocation, preserving redaction and temporary source errors.
        if (ownershipError instanceof OpenClawSourceOwnershipError)
          throw new Error("history-source-owner-changed", { cause: ownershipError });
      }
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    readers.close();
    if (!options.commands) commands.close();
  }
}

/** Reuse handoff redaction for structured tool values as well as ordinary message text. */
export function sanitizeHistorySourceText(content: string): string {
  if (/^\s*[[{]/.test(content)) {
    try {
      return sanitizeHandoffExport(content, "json").trimEnd();
    } catch (error) {
      // Only invalid JSON is prose. A structured-redaction failure must never fall
      // back to the weaker text sanitizer or publish a partially protected index.
      if (!(error instanceof SyntaxError))
        throw new Error("history-source-redaction-failed", { cause: error });
    }
  }
  return sanitizeSessionText(content, { value: 0 });
}

async function emitTurns(turns: SessionDocument["turns"], sink: HistorySourceSink): Promise<void> {
  for (const turn of turns) {
    sink.checkpoint();
    for (const [index, block] of turn.blocks.entries()) {
      const timestamp = jsonTimestamp(turn.timestamp);
      if (block.type === "text" && ["user", "assistant"].includes(turn.role))
        await sink.emit({
          recordId: `${turn.id}:${index}`,
          kind: turn.role as "user" | "assistant",
          content: block.text,
          toolName: null,
          timestamp,
        });
      else if (block.type === "tool-call")
        await sink.emit({
          recordId: `call:${block.call_id}:input`,
          kind: "tool-input",
          content: block.input,
          toolName: block.name,
          timestamp,
        });
      else if (block.type === "tool-result")
        await sink.emit({
          recordId: `call:${block.call_id}:output`,
          kind: "tool-output",
          content: block.output,
          toolName: null,
          timestamp,
        });
    }
  }
}
