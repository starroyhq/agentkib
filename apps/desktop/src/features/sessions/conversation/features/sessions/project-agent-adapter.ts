import type { ProjectAgentPanelClient } from "@agentkib/session-ui";
import { desktopApi } from "@/core/desktop";

const operations = {
  designate: "lead-designate",
  update: "lead-update",
  pause: "lead-pause",
  resume: "lead-resume",
  release: "lead-release",
  "remove-worker": "lead-worker-remove",
  "stop-worker": "lead-worker-stop",
};

/** Optional, like the other computer settings: a bridge that cannot answer hides it. */
const request = (params: Record<string, unknown>) =>
  Promise.resolve().then(() => desktopApi().claude.request(params));

export const desktopProjectAgentClient: ProjectAgentPanelClient = {
  projectAgent(sessionId) {
    return request({ operation: "lead-status", sessionId });
  },
  manageProjectAgent({ operation, ...params }) {
    return request({ ...params, operation: operations[operation] });
  },
};
