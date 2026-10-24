export type DoctorIssueDestination = "context" | "skills" | "mcp";

const manualActions: Record<string, { guidanceKey: string; destination?: DoctorIssueDestination }> =
  {
    "manifest.invalid": { guidanceKey: "doctor.manual.manifest" },
    "native.invalid": { guidanceKey: "doctor.manual.native" },
    "skill.source-unavailable": { guidanceKey: "doctor.manual.skillSource", destination: "skills" },
    "skill.target-missing": { guidanceKey: "doctor.manual.skillTarget" },
    "managed.missing": { guidanceKey: "doctor.manual.managed" },
    "managed.drift": { guidanceKey: "doctor.manual.managed" },
    "instruction.missing": { guidanceKey: "doctor.manual.instruction", destination: "context" },
    "instruction.expected-content-missing": {
      guidanceKey: "doctor.manual.instruction",
      destination: "context",
    },
    "instruction.exact-duplicate": {
      guidanceKey: "doctor.manual.duplicate",
      destination: "context",
    },
    "instruction.unmanaged-duplicate": {
      guidanceKey: "doctor.manual.duplicate",
      destination: "context",
    },
    "context.warning": { guidanceKey: "doctor.manual.context", destination: "context" },
    "context.unavailable": { guidanceKey: "doctor.manual.context", destination: "context" },
    "mcp.config-unavailable": { guidanceKey: "doctor.manual.mcpConfig" },
    "mcp.target-missing": { guidanceKey: "doctor.manual.mcpTarget" },
    "agent.read-only": { guidanceKey: "doctor.manual.readOnly" },
  };

export function doctorManualAction(code: string) {
  return Object.hasOwn(manualActions, code)
    ? manualActions[code]!
    : { guidanceKey: "doctor.manual.other" };
}
