import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { Sql, positive, type Row } from "./sql";
import { agentSchema, optionalString, parameters, unsigned } from "./rpc";
import { loadManifest } from "./manifest";
import { timestamp } from "./timestamps";
import { storedTime, utcNow } from "./workspaces";
const statusSchema = z.enum(["pending", "approved", "rejected", "invalidated"]);
const memoryType = z.enum([
  "user_preference",
  "project_fact",
  "decision",
  "constraint",
  "failed_attempt",
  "open_loop",
  "task_state",
  "agent_observation",
]);
const memoryFields =
  "id,project_id,memory_type,content,status,source_agent,source_thread,source_reference,created_at,approved_at,invalidated_by";
const assetKinds = z.enum([
  "instruction",
  "skill",
  "connection",
  "agent",
  "hook",
  "memory",
  "configuration",
]);
export class Catalog {
  constructor(readonly sql: Sql) {}
  request(method: string, value: unknown): unknown {
    switch (method) {
      case RUNTIME_METHODS.listAgentInstallations:
        return this.installations();
      case RUNTIME_METHODS.searchCatalogAssets: {
        const params = parameters(
          z.object({
            query: z.string().default(""),
            agent: agentSchema.nullable().optional(),
            workspaceId: optionalString,
            limit: unsigned.default(500),
          }),
          value,
        );
        return this.assets(params);
      }
      case RUNTIME_METHODS.listGlobalMemories: {
        const params = parameters(z.object({ status: statusSchema.nullable().optional() }), value);
        return this.memories(null, params.status ?? null);
      }
      case RUNTIME_METHODS.listMemories: {
        const params = parameters(
          z.object({ project: z.string(), status: statusSchema.nullable().optional() }),
          value,
        );
        return this.memories(loadManifest(params.project).workspace.id, params.status ?? null);
      }
      case RUNTIME_METHODS.searchMemories: {
        const params = parameters(
          z.object({ project: z.string(), query: z.string(), limit: unsigned }),
          value,
        );
        return this.search(
          loadManifest(params.project).workspace.id,
          params.query,
          Math.min(50, Math.max(1, params.limit)),
        );
      }
      case RUNTIME_METHODS.proposeMemory: {
        const params = parameters(
          z.object({
            project: z.string(),
            proposal: z.object({
              project_id: z.string(),
              memory_type: memoryType,
              content: z.string(),
              source_agent: optionalString,
              source_thread: optionalString,
              source_reference: optionalString,
            }),
          }),
          value,
        );
        return this.propose({
          ...params.proposal,
          project_id: loadManifest(params.project).workspace.id,
        });
      }
      case RUNTIME_METHODS.reviewMemory: {
        const params = parameters(
          z.object({ id: z.string(), status: statusSchema, editedContent: optionalString }),
          value,
        );
        return this.review(params.id, params.status, params.editedContent ?? null);
      }
      default:
        throw new Error(`Unknown catalog method: ${method}`);
    }
  }
  installations() {
    return this.sql
      .rows(
        "SELECT agent,installed,configured,version,home,warnings FROM agent_installations ORDER BY agent",
      )
      .map((row) => {
        const agent = agentSchema.parse(row.agent),
          session_list = [
            "codex",
            "claude-code",
            "opencode",
            "open-claw",
            "hermes",
            "grok-build",
            "antigravity",
            "cursor",
          ].includes(agent);
        return {
          ...row,
          agent,
          installed: Number(row.installed) !== 0,
          configured: Number(row.configured) !== 0,
          warnings: z.array(z.string()).parse(JSON.parse(String(row.warnings))),
          support: {
            workspace_discovery: true,
            session_list,
            history_read: session_list,
            continuation: ["codex", "claude-code", "opencode", "antigravity"].includes(agent),
            control: ["codex", "antigravity"].includes(agent) ? "experimental" : "none",
          },
        };
      });
  }
  assets(params: {
    query: string;
    agent?: string | null;
    workspaceId?: string | null;
    limit: number;
  }) {
    const pattern = `%${params.query.trim().replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    return this.sql
      .rows(
        "SELECT id,scope,workspace_id,agent,kind,name,path,summary,size,modified_at,summary_key,summary_params FROM catalog_assets WHERE (name LIKE ?1 ESCAPE '\\' OR path LIKE ?1 ESCAPE '\\' OR summary LIKE ?1 ESCAPE '\\' OR COALESCE(summary_key,'') LIKE ?1 ESCAPE '\\') AND (?2 IS NULL OR agent=?2) AND (?3 IS NULL OR workspace_id=?3) ORDER BY modified_at DESC,name ASC LIMIT ?4",
        pattern,
        params.agent ?? null,
        params.workspaceId ?? null,
        Math.min(500, Math.max(1, params.limit)),
      )
      .map((row) => {
        const { summary_key, summary_params, ...rest } = row;
        const summaryParams = z
          .record(z.string(), z.string())
          .parse(JSON.parse(String(summary_params)));
        return {
          ...rest,
          scope: z.enum(["workspace", "agent-home", "agentkib-home"]).parse(row.scope),
          agent: row.agent === null ? null : agentSchema.parse(row.agent),
          kind: assetKinds.parse(row.kind),
          size: positive(row.size),
          modified_at: timestamp(row.modified_at),
          ...(summary_key === null ? {} : { summary_key }),
          ...(Object.keys(summaryParams).length ? { summary_params: summaryParams } : {}),
        };
      });
  }
  memories(project: string | null, status: string | null) {
    return this.sql
      .rows(
        `SELECT ${memoryFields} FROM memories WHERE (?1 IS NULL OR project_id=?1) AND (?2 IS NULL OR status=?2) ORDER BY created_at DESC`,
        project,
        status,
      )
      .map(memory);
  }
  search(project: string, query: string, limit: number) {
    if (!query.trim()) return this.memories(project, "approved").slice(0, limit);
    const search = query
      .trim()
      .split(/\s+/u)
      .map((word) => `"${word.replaceAll('"', '""')}"`)
      .join(" AND ");
    return this.sql
      .rows(
        `SELECT ${memoryFields
          .split(",")
          .map((field) => `m.${field}`)
          .join(
            ",",
          )} FROM memories_fts f JOIN memories m ON m.id=f.id WHERE f.project_id=? AND memories_fts MATCH ? AND m.status='approved' ORDER BY rank LIMIT ?`,
        project,
        search,
        limit,
      )
      .map(memory);
  }
  propose(proposal: {
    project_id: string;
    memory_type: string;
    content: string;
    source_agent?: string | null;
    source_thread?: string | null;
    source_reference?: string | null;
  }) {
    const content = proposal.content.trim();
    if (!content) throw new Error("Memory content cannot be empty");
    const id = randomUUID(),
      at = storedTime(utcNow());
    return this.sql.transaction(() => {
      this.sql.run(
        "INSERT INTO memories(id,project_id,memory_type,content,status,source_agent,source_thread,source_reference,created_at) VALUES (?,?,?,?,'pending',?,?,?,?)",
        id,
        proposal.project_id,
        proposal.memory_type,
        content,
        proposal.source_agent ?? null,
        proposal.source_thread ?? null,
        proposal.source_reference ?? null,
        at,
      );
      this.sql.audit(proposal.project_id, "memory.propose", id);
      return this.get(id);
    });
  }
  review(id: string, status: string, content: string | null) {
    if (!["approved", "rejected", "invalidated"].includes(status))
      throw new Error("Review status must be approved, rejected, or invalidated");
    if (content !== null && !content.trim()) throw new Error("Memory content cannot be empty");
    return this.sql.transaction(() => {
      const at = status === "approved" ? storedTime(utcNow()) : null;
      if (content !== null)
        this.sql.run(
          "UPDATE memories SET content=?,status=?,approved_at=? WHERE id=?",
          content.trim(),
          status,
          at,
          id,
        );
      else this.sql.run("UPDATE memories SET status=?,approved_at=? WHERE id=?", status, at, id);
      const record = this.get(id);
      this.sql.audit(String(record.project_id), "memory.review", `${id}:${status}`);
      return record;
    });
  }
  get(id: string) {
    const row = this.sql.one(`SELECT ${memoryFields} FROM memories WHERE id=?`, id);
    if (!row) throw new Error("Memory does not exist");
    return memory(row);
  }
}
function memory(row: Row) {
  return {
    ...row,
    content: String(row.content),
    project_id: String(row.project_id),
    memory_type: memoryType.parse(row.memory_type),
    status: statusSchema.parse(row.status),
    created_at: timestamp(row.created_at),
    approved_at: timestamp(row.approved_at),
  };
}
