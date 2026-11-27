import { REMOTE_WORKER_ROLE_CONTRACT } from "@agentkib/runtime-protocol";

const settingsGrants = ["send", "manage", "advancedControl"] as const;

type ProjectAgentOperation = {
  backend: string;
  grants: ReadonlyArray<"send" | "manage" | "advancedControl">;
  needsWorker?: true;
  checkCurrent?: true;
};

export const projectAgentOperations: Record<string, ProjectAgentOperation> = {
  status: { backend: "lead-status", grants: [] },
  pause: { backend: "lead-pause", grants: ["send"] },
  release: { backend: "lead-release", grants: ["manage"] },
  designate: { backend: "lead-designate", grants: settingsGrants },
  update: { backend: "lead-update", grants: settingsGrants, checkCurrent: true },
  resume: { backend: "lead-resume", grants: settingsGrants, checkCurrent: true },
  "remove-worker": { backend: "lead-worker-remove", grants: ["manage"], needsWorker: true },
  "stop-worker": { backend: "lead-worker-stop", grants: ["send"], needsWorker: true },
  [REMOTE_WORKER_ROLE_CONTRACT.operation]: {
    backend: REMOTE_WORKER_ROLE_CONTRACT.controlOperation,
    grants: settingsGrants,
    needsWorker: true,
    checkCurrent: true,
  },
};
