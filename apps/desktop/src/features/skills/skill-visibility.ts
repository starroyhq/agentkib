import type { AgentKind, SkillObservation } from "@/core/types";

type LoadIssueKind = "blocked" | "unknown" | "confirmation";
type LoadReason =
  | "noGitRoot"
  | "differentGitRoot"
  | "projectDiscoveryDisabled"
  | "projectNotTrusted"
  | "trustUnavailable"
  | "nativeConfigDisabled"
  | "nativeWorkspaceMissing"
  | "configUnavailable"
  | "allowlistExcluded"
  | "permissionRequired"
  | "unverified";

export interface SkillLoadIssue {
  observation: SkillObservation;
  agent: AgentKind;
  kind: LoadIssueKind;
  reason: LoadReason;
  context?: string;
}

interface DiagnosticRule {
  pattern: RegExp;
  agent: AgentKind;
  kind?: LoadIssueKind;
  reason?: LoadReason;
  context?: boolean;
}

// Match the backend's known diagnostics, including native profile and Agent IDs.
// Ownership and read-only installation notes say nothing about native loading.
const diagnosticRules: DiagnosticRule[] = [
  {
    pattern: /^Hermes: project skills are not loaded because this project has no Git root$/,
    agent: "hermes",
    kind: "blocked",
    reason: "noGitRoot",
  },
  {
    pattern:
      /^Hermes: native project discovery reads the nearest Git root .+, not this nested project directory$/,
    agent: "hermes",
    kind: "blocked",
    reason: "differentGitRoot",
  },
  {
    pattern: /^Hermes profile (.+): project discovery is disabled in config\.yaml$/,
    agent: "hermes",
    kind: "blocked",
    reason: "projectDiscoveryDisabled",
    context: true,
  },
  {
    pattern:
      /^Hermes profile (.+): Git root is not trusted; run hermes skills trust yourself before native loading$/,
    agent: "hermes",
    kind: "confirmation",
    reason: "projectNotTrusted",
    context: true,
  },
  {
    pattern:
      /^Hermes profile (.+): project trust is unknown because config\.yaml could not be read$/,
    agent: "hermes",
    kind: "unknown",
    reason: "trustUnavailable",
    context: true,
  },
  {
    pattern:
      /^Hermes profile (.+): Git root is trusted; native content quarantine and session refresh still apply$/,
    agent: "hermes",
    context: true,
  },
  {
    pattern:
      /^OpenClaw: this Skill name is disabled by skills\.entries in openclaw\.json; metadata skillKey aliases may differ$/,
    agent: "open-claw",
    kind: "blocked",
    reason: "nativeConfigDisabled",
  },
  {
    pattern:
      /^OpenClaw: this project has no configured native Agent workspace, so its Skill files are not discoverable$/,
    agent: "open-claw",
    kind: "blocked",
    reason: "nativeWorkspaceMissing",
  },
  {
    pattern:
      /^OpenClaw: native enablement is unknown because workspace or skills configuration could not be resolved$/,
    agent: "open-claw",
    kind: "unknown",
    reason: "configUnavailable",
  },
  {
    pattern:
      /^OpenClaw Agent (.+): excluded by its effective skills allowlist \(per-Agent settings replace defaults\)$/,
    agent: "open-claw",
    kind: "blocked",
    reason: "allowlistExcluded",
    context: true,
  },
  {
    pattern:
      /^OpenClaw Agent (.+): allowed by its effective skills allowlist \(per-Agent settings replace defaults\)$/,
    agent: "open-claw",
    context: true,
  },
  {
    pattern: /^OpenCode: permission\.skill is deny for this Skill$/,
    agent: "opencode",
    kind: "blocked",
    reason: "nativeConfigDisabled",
  },
  {
    pattern: /^OpenCode: permission\.skill is ask for this Skill$/,
    agent: "opencode",
    kind: "confirmation",
    reason: "permissionRequired",
  },
  {
    pattern:
      /^OpenCode: native enablement is unknown because a configuration file could not be read or parsed$/,
    agent: "opencode",
    kind: "unknown",
    reason: "configUnavailable",
  },
  {
    pattern: /^Codex: this Skill is disabled by skills\.config in config\.toml$/,
    agent: "codex",
    kind: "blocked",
    reason: "nativeConfigDisabled",
  },
  {
    pattern: /^Codex: native enablement is unknown because config\.toml could not be read$/,
    agent: "codex",
    kind: "unknown",
    reason: "configUnavailable",
  },
  {
    pattern: /^Grok: compat\.(claude|cursor)\.skills is disabled$/,
    agent: "grok-build",
    kind: "blocked",
    reason: "nativeConfigDisabled",
  },
  {
    pattern:
      /^Grok: native skills\.disabled, skills\.ignore or compatibility settings restrict this Skill$/,
    agent: "grok-build",
    kind: "blocked",
    reason: "nativeConfigDisabled",
  },
  {
    pattern: /^Grok: native enablement is unknown because config\.toml could not be read$/,
    agent: "grok-build",
    kind: "unknown",
    reason: "configUnavailable",
  },
];
const neutralDiagnostics = new Map([
  ["Linked Skill is read-only until copied to the library", false],
  ["Deployment ownership could not be verified", true],
  ["Shared package managed outside AgentKib", false],
  ["Interrupted Skill synchronization requires recovery", true],
]);
const agentPrefixes: Array<[RegExp, AgentKind]> = [
  [/^Hermes(?: profile .+)?:/, "hermes"],
  [/^OpenClaw(?: Agent .+)?:/, "open-claw"],
  [/^OpenCode:/, "opencode"],
  [/^Codex:/, "codex"],
  [/^Grok:/, "grok-build"],
];

export function skillObservationVisibility(observations: readonly SkillObservation[]) {
  const visibleAgents = new Set<AgentKind>();
  const issues: SkillLoadIssue[] = [];
  let hasOtherDiagnostics = false;
  for (const observation of observations) {
    const localIssues: SkillLoadIssue[] = [];
    const positiveContexts = new Set<AgentKind>();
    const addIssue = (
      agent: AgentKind,
      kind: LoadIssueKind,
      reason: LoadReason,
      context?: string,
    ) => {
      if (!observation.agents.includes(agent)) return;
      if (
        !localIssues.some(
          (issue) =>
            issue.agent === agent &&
            issue.kind === kind &&
            issue.reason === reason &&
            issue.context === context,
        )
      )
        localIssues.push({ observation, agent, kind, reason, context });
    };
    for (const diagnostic of observation.diagnostics) {
      const rule = diagnosticRules.find((entry) => entry.pattern.test(diagnostic));
      if (rule) {
        const context = rule.context ? rule.pattern.exec(diagnostic)?.[1] : undefined;
        if (rule.kind && rule.reason) addIssue(rule.agent, rule.kind, rule.reason, context);
        else positiveContexts.add(rule.agent);
      } else if (neutralDiagnostics.has(diagnostic))
        hasOtherDiagnostics ||= neutralDiagnostics.get(diagnostic) === true;
      else {
        const knownAgent = agentPrefixes.find(([prefix]) => prefix.test(diagnostic))?.[1];
        const affected = knownAgent ? [knownAgent] : observation.agents;
        for (const agent of affected) addIssue(agent, "unknown", "unverified");
        hasOtherDiagnostics = true;
      }
    }
    // Backend statuses are aggregate values. A named Agent's restriction must not
    // hide its neighbours in a shared native root, or a separate positive alias.
    for (const agent of observation.agents) {
      const agentIssues = localIssues.filter((issue) => issue.agent === agent);
      // Ownership/recovery aggregation can replace a broken link's status.
      // Its unresolved target still cannot be a positive loading observation.
      if (
        (observation.kind === "symlink" && observation.resolved_path === null) ||
        ["broken-link", "link-loop", "invalid"].includes(observation.status)
      )
        addIssue(agent, "unknown", "unverified");
      else if (agentIssues.length === 0) {
        if (observation.status === "native-restricted")
          addIssue(agent, "blocked", "nativeConfigDisabled");
        else if (observation.status === "pending-trust")
          addIssue(agent, "confirmation", "projectNotTrusted");
        else if (
          observation.status === "unverified" &&
          !observation.diagnostics.includes("Deployment ownership could not be verified")
        )
          addIssue(agent, "unknown", "unverified");
      }
      const currentIssues = localIssues.filter((issue) => issue.agent === agent);
      if (
        currentIssues.length === 0 ||
        (positiveContexts.has(agent) && currentIssues.every((issue) => issue.context))
      )
        visibleAgents.add(agent);
    }
    issues.push(...localIssues);
  }
  return { visibleAgents: [...visibleAgents], issues, hasOtherDiagnostics };
}
