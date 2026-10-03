import path from "node:path";
import { z } from "zod";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { AGENTS, parameters } from "./rpc";
import { Context } from "./context";
import { scanWorkspace } from "./asset-scanner";
import { withinLexical } from "./files";
import { isDirectory, pathIdentity } from "./paths";
import { loadManifest, manifestPath, type Manifest } from "./manifest";
import { effectiveMcp, type McpServer } from "./mcp-config-read";
import { compareUtf8, utcNow } from "./workspaces";
import {
  adapterEnabled,
  assetKind,
  fileHash,
  hash,
  instructionRepairable,
  mcpRepairable,
  normalize,
  safeTarget,
  skillCurrent,
  skillFiles,
  skillRepairable,
  type Agent,
} from "./doctor-files";
interface Issue {
  id: string;
  code: string;
  severity: "error" | "warning" | "info";
  agent?: Agent;
  asset_kind?: string;
  repairable: boolean;
  evidence: { path?: string; detail: string; expected?: string; actual?: string }[];
}
const variants: Record<Agent, string> = {
  codex: "Codex",
  "claude-code": "ClaudeCode",
  cursor: "Cursor",
  opencode: "OpenCode",
  "open-claw": "OpenClaw",
  hermes: "Hermes",
  "grok-build": "GrokBuild",
  antigravity: "Antigravity",
  "deepseek-harness": "DeepSeekHarness",
};
const summary = (workspace_id: string, issues: Issue[]) => ({
  workspace_id,
  error_count: issues.filter((i) => i.severity === "error").length,
  warning_count: issues.filter((i) => i.severity === "warning").length,
  info_count: issues.filter((i) => i.severity === "info").length,
  repairable_count: issues.filter((i) => i.repairable).length,
  checked_at: utcNow(),
});
export class Doctor {
  constructor(
    readonly context: Context,
    readonly workspacePath: (id: string) => string,
  ) {}
  async request(method: string, value: unknown) {
    if (method === RUNTIME_METHODS.workspaceDoctorReport)
      return this.report(parameters(z.object({ id: z.string() }), value).id);
    const { workspaceIds } = parameters(z.object({ workspaceIds: z.array(z.string()) }), value);
    if (workspaceIds.length > 100)
      throw new Error("workspace doctor accepts at most 100 workspaces");
    const results = [];
    for (const id of workspaceIds)
      try {
        results.push((await this.report(id)).summary);
      } catch {
        results.push({ ...summary(id, []), error_count: 1 });
      }
    return results;
  }
  async report(id: string) {
    const scan = scanWorkspace(this.workspacePath(id)),
      project = scan.root,
      issues: Issue[] = [],
      matrix = [];
    const push = (
      code: string,
      severity: Issue["severity"],
      agent: Agent | null,
      kind: string | null,
      repairable: boolean,
      file: string | null,
      detail: string,
      expected: string | null = null,
      actual: string | null = null,
    ) => {
      const source = `${code}:${agent === null ? "None" : `Some(${variants[agent]})`}:${file === null ? "None" : `Some(${JSON.stringify(file)})`}:${detail}`;
      issues.push({
        id: hash(source).slice(0, 16),
        code,
        severity,
        ...(agent ? { agent } : {}),
        ...(kind ? { asset_kind: kind } : {}),
        repairable,
        evidence: [
          {
            ...(file ? { path: file } : {}),
            detail,
            ...(expected !== null ? { expected } : {}),
            ...(actual !== null ? { actual } : {}),
          },
        ],
      });
    };
    let manifest: Manifest | null = null,
      manifestError: string | null = null;
    if (scan.manifest_exists)
      try {
        manifest = loadManifest(project);
      } catch (error) {
        manifestError = (error as Error).message;
      }
    const installed = new Set(
      this.context.catalog
        .installations()
        .filter((row) => row.installed)
        .map((row) => row.agent),
    );
    let servers: McpServer[] = [],
      mcpError: string | null = null;
    try {
      servers = effectiveMcp(project, this.context.environment);
    } catch (error) {
      mcpError = (error as Error).message;
    }
    if (mcpError)
      push(
        "mcp.config-unavailable",
        "error",
        null,
        "configuration",
        false,
        null,
        mcpError,
        "Readable, valid MCP configuration",
        "Unavailable",
      );
    if (manifestError)
      push(
        "manifest.invalid",
        "error",
        null,
        "configuration",
        false,
        manifestPath(project),
        manifestError,
      );
    for (const warning of scan.warnings) {
      if (warning === manifestError) continue;
      push(
        "native.invalid",
        "error",
        scan.agents.find((item) => item.warnings.includes(warning))?.agent ?? null,
        "configuration",
        false,
        null,
        warning,
      );
    }
    if (manifest) {
      for (const skill of manifest.skills)
        if (!skillFiles(project, path.join(project, skill.path)))
          push(
            "skill.source-unavailable",
            "error",
            null,
            "skill",
            false,
            path.join(project, skill.path),
            `Skill source is missing, unreadable, or has no SKILL.md: ${skill.name}`,
          );
      for (const agent of AGENTS) {
        const state = manifest.adapters[agent];
        if (!state?.enabled) continue;
        for (const target of Object.keys(state.generated_hashes).sort(compareUtf8)) {
          const file = path.isAbsolute(target) ? target : `${project}${path.sep}${target}`,
            expected = state.generated_hashes[target]!,
            actual = fileHash(file);
          if (actual.value === expected) continue;
          push(
            actual.kind === "missing" ? "managed.missing" : "managed.drift",
            "warning",
            agent,
            assetKind(file),
            withinLexical(file, project) &&
              safeTarget(project, file) &&
              actual.kind !== "unavailable" &&
              agent !== "deepseek-harness",
            file,
            actual.kind === "missing"
              ? "AgentKib-managed file is missing"
              : actual.kind === "unavailable"
                ? "AgentKib-managed file is not a readable bounded regular file"
                : "AgentKib-managed file differs from its recorded hash",
            expected,
            actual.value ?? null,
          );
        }
      }
    }
    for (const agent of AGENTS) {
      const native = scan.agents.find((item) => item.agent === agent),
        detected = native?.detected ?? false,
        installedAgent = installed.has(agent),
        applicable = detected || installedAgent,
        writable = agent !== "deepseek-harness",
        enabled = writable && (manifest ? adapterEnabled(manifest, agent) : applicable),
        active = applicable && (enabled || agent === "deepseek-harness");
      const fragments: { cwd: string; content: string; scoped: boolean }[] = [];
      if (manifest) {
        if (manifest.instructions.shared.trim())
          fragments.push({ cwd: project, content: manifest.instructions.shared, scoped: false });
        const override = manifest.instructions.platform_overrides[agent];
        if (override?.trim()) fragments.push({ cwd: project, content: override, scoped: false });
        for (const rule of manifest.instructions.scoped)
          if (rule.content.trim())
            fragments.push({
              cwd: path.join(project, rule.path),
              content: rule.content,
              scoped: true,
            });
      }
      const instructionExpected = fragments.length;
      let instructionActual = 0;
      const skills =
          manifest?.skills.filter(
            (skill) => !skill.targets.length || skill.targets.includes(agent),
          ) ?? [],
        skillExpected = skills.length,
        skillActual = manifest
          ? skills.filter((skill) => skillCurrent(project, manifest, agent, skill)).length
          : 0,
        canRepairSkills = manifest
          ? skills
              .filter((skill) => !skillCurrent(project, manifest, agent, skill))
              .every((skill) => skillRepairable(project, manifest, agent, skill))
          : true;
      const expectedMcp = new Set(
        manifest && writable
          ? manifest.connections
              .filter(
                (connection) =>
                  connection.name !== "agentkib" &&
                  (!connection.targets.length || connection.targets.includes(agent)),
              )
              .map((connection) => connection.name)
          : [],
      );
      if (active) {
        const cwds = [project];
        for (const fragment of fragments)
          if (isDirectory(fragment.cwd) && !cwds.includes(fragment.cwd)) cwds.push(fragment.cwd);
        const sections: Awaited<ReturnType<Context["resolve"]>>["sections"] = [],
          satisfied = new Set<number>(),
          indeterminate = new Set<number>(),
          seenWarnings = new Set<string>();
        let missingReported = false;
        for (const cwd of cwds)
          try {
            const preview = await this.context.resolve(project, cwd, agent, manifest, []),
              truncated = preview.warnings.some(
                (warning) =>
                  !warning.startsWith("Agent home: ") &&
                  (warning.includes("truncated for preview") ||
                    warning.includes("instruction budget")),
              ),
              current = preview.sections.filter(
                (section) => !["platform-override", "agent-home"].includes(section.scope),
              ),
              here = fragments
                .map((fragment, index) => ({ fragment, index }))
                .filter(({ fragment }) => fragment.cwd === cwd);
            for (const { fragment, index } of here) {
              if (
                current.some(
                  (section) =>
                    normalize(section.content).includes(normalize(fragment.content)) &&
                    (!fragment.scoped ||
                      pathIdentity(path.dirname(section.source)) === pathIdentity(cwd)),
                )
              )
                satisfied.add(index);
              if (truncated) indeterminate.add(index);
            }
            for (const warning of preview.warnings) {
              if (warning.startsWith("Agent home: ")) continue;
              const missing = warning.includes("No project instruction");
              if (
                warning.includes("semantic conflicts") ||
                (missing && !here.length) ||
                seenWarnings.has(warning)
              )
                continue;
              seenWarnings.add(warning);
              missingReported ||= missing;
              push(
                missing ? "instruction.missing" : "context.warning",
                "warning",
                agent,
                "instruction",
                missing &&
                  enabled &&
                  writable &&
                  here.every(({ fragment }) =>
                    instructionRepairable(
                      project,
                      fragment.cwd,
                      agent,
                      manifest,
                      fragment.content,
                      fragment.scoped,
                    ),
                  ),
                cwd,
                warning,
              );
            }
            for (const section of current)
              if (!sections.some((existing) => existing.source === section.source))
                sections.push(section);
          } catch (error) {
            push(
              "context.unavailable",
              "error",
              agent,
              "instruction",
              false,
              cwd,
              (error as Error).message,
            );
          }
        instructionActual = fragments.length
          ? new Set([...satisfied, ...indeterminate]).size
          : sections.length;
        const seen = new Map<string, string>();
        for (const section of sections) {
          const text = normalize(section.content);
          if (!text) continue;
          const first = seen.get(text);
          seen.set(text, section.source);
          if (first)
            push(
              "instruction.exact-duplicate",
              "warning",
              agent,
              "instruction",
              false,
              section.source,
              `Exact duplicate of ${first}`,
            );
        }
        if (instructionActual < instructionExpected && !missingReported) {
          const missing = fragments.filter(
            (_, index) => !satisfied.has(index) && !indeterminate.has(index),
          );
          if (missing.length)
            push(
              "instruction.expected-content-missing",
              "warning",
              agent,
              "instruction",
              enabled &&
                writable &&
                missing.every((fragment) =>
                  instructionRepairable(
                    project,
                    fragment.cwd,
                    agent,
                    manifest,
                    fragment.content,
                    fragment.scoped,
                  ),
                ),
              missing[0]!.cwd,
              "Configured instructions are not present in native context sources",
              String(instructionExpected),
              String(instructionActual),
            );
        }
      }
      if (active && skillActual < skillExpected)
        push(
          "skill.target-missing",
          "warning",
          agent,
          "skill",
          enabled && writable && canRepairSkills,
          null,
          "Manifest Skills are not all visible in the target Agent's project paths",
          String(skillExpected),
          String(skillActual),
        );
      if (agent === "deepseek-harness" && detected)
        push(
          "agent.read-only",
          "info",
          agent,
          null,
          false,
          null,
          "DeepSeek Harness is available for diagnostics only",
        );
      const visible = new Set(
          servers
            .filter(
              (server) =>
                server.enabled && (!server.targets.length || server.targets.includes(agent)),
            )
            .map((server) => server.name),
        ),
        mcpExpected = expectedMcp.size,
        mcpActual = expectedMcp.size
          ? [...expectedMcp].filter((name) => visible.has(name)).length
          : visible.size;
      if (active && !mcpError && [...expectedMcp].some((name) => !visible.has(name)))
        push(
          "mcp.target-missing",
          "warning",
          agent,
          "connection",
          enabled &&
            writable &&
            (!native || !native.warnings.length) &&
            mcpRepairable(project, agent),
          null,
          "Manifest MCP connections are not all visible to the target Agent",
          [...expectedMcp].sort(compareUtf8).join(", "),
          [...visible].sort(compareUtf8).join(", "),
        );
      const agentIssues = issues.filter((issue) => issue.agent === agent),
        attention = (kind: string) =>
          agentIssues.some((issue) => issue.asset_kind === kind && issue.severity !== "info"),
        base = applicable && manifestError ? "unavailable" : active ? "healthy" : "not-applicable",
        status = (flag: boolean) => (base === "not-applicable" ? base : flag ? "attention" : base);
      matrix.push({
        agent,
        detected,
        installed: installedAgent,
        enabled,
        writable,
        instructions: {
          status: status(attention("instruction")),
          expected: instructionExpected,
          actual: instructionActual,
        },
        skills: {
          status: status(attention("skill") || skillActual < skillExpected),
          expected: skillExpected,
          actual: skillActual,
        },
        mcp: {
          status:
            mcpError && active
              ? "unavailable"
              : status((!!mcpError && active) || attention("connection")),
          expected: mcpExpected,
          actual: mcpActual,
        },
      });
    }
    for (const issue of issues) for (const evidence of issue.evidence) evidence.path ??= project;
    if (
      issues.some(
        (issue) =>
          !issue.repairable &&
          issue.severity !== "info" &&
          ([
            "skill.source-unavailable",
            "native.invalid",
            "context.unavailable",
            "mcp.config-unavailable",
          ].includes(issue.code) ||
            (["managed.missing", "managed.drift"].includes(issue.code) &&
              issue.evidence.some((evidence) => withinLexical(evidence.path!, project)))),
      )
    )
      for (const issue of issues) issue.repairable = false;
    const ranks = { error: 0, warning: 1, info: 2 };
    issues.sort(
      (a, b) =>
        ranks[a.severity] - ranks[b.severity] ||
        compareUtf8(a.code, b.code) ||
        compareUtf8(a.id, b.id),
    );
    return { summary: summary(id, issues), matrix, issues };
  }
}
