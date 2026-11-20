import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestrationService } from "../../../../packages/backend/src/orchestration-service";

/** A real tool registry with no Workers or native execution, for testing the transport. */
export function projectAgentFixture(sessionId: string, workspaceId: string) {
  const root = mkdtempSync(join(tmpdir(), "ak-project-agent-tools-"));
  const service = new OrchestrationService(
    root,
    "fixture-boot",
    {
      control: async () => {
        throw new Error("unexpected fixture worker control");
      },
      live: async () => ({}),
      events: async () => [],
      session: () => null,
      managed: async () => false,
      workspaces: () => [{ id: workspaceId, name: "Fixture" }],
    },
    (id) => id === sessionId,
  );
  service.designate({ sessionId, deviceId: "desktop-local", workspaceId });
  return {
    service,
    async close() {
      try {
        await service.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
