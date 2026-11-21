import { app, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DesktopRuntimeHost } from "../main/runtime-host";
import { RuntimeRouter } from "../main/runtime-router";
import { ConversationHub } from "../main/conversation-hub";
import {
  WebAccessService,
  createWebControlState,
  type HostSessionRequest,
} from "../main/web/service";
import { registerConversationIpc } from "../main/ipc/conversation";
import { RUNTIME_METHODS } from "../generated/runtime-protocol";

const scratch = process.env.AGENTKIB_CONVERSATION_BENCHMARK;
const executablePath = process.env.AGENTKIB_RUNTIME_PATH;
if (!scratch || !executablePath) throw new Error("Missing isolated benchmark configuration");
app.setPath("userData", path.join(scratch, "electron"));
app.setName("AgentKib conversation benchmark");
const runtimeHost = new DesktopRuntimeHost({
  executablePath,
  args: process.env.AGENTKIB_RUNTIME_ARGS ? [process.env.AGENTKIB_RUNTIME_ARGS] : [],
  clientVersion: "benchmark",
  maxRestarts: 0,
  environment: { ELECTRON_RUN_AS_NODE: "1" },
});
const runtime = new RuntimeRouter(runtimeHost, path.join(scratch, "backend"));
const hub = new ConversationHub((method, params) => runtime.request(method, params));
runtime.on("notification", (method: string, params: unknown) => hub.notification(method, params));
const requestSession = <T>(params: HostSessionRequest) =>
  runtime.request<T>(RUNTIME_METHODS.sessionRequest, params);
const service = new WebAccessService({
  conversationHub: hub,
  sharedControl: createWebControlState(),
  dataDir: path.join(scratch, "web"),
  staticDir: path.join(scratch, "renderer"),
  desktopOrigin: "file://",
  verifiedCodex: true,
  sessionRequest: requestSession,
  receiptRequest: (params) => runtime.request(RUNTIME_METHODS.controlReceipt, params),
  workspaceRequest: () => runtime.request(RUNTIME_METHODS.listWorkspaces, {}),
});
let window: BrowserWindow | undefined;
let finishing = false;
async function finish(code: number) {
  if (finishing) return;
  finishing = true;
  await service.shutdown();
  await runtime.stop();
  window?.destroy();
  app.exit(code);
}
app.on("window-all-closed", () => {
  if (!finishing) void finish(1);
});
const timeout = setTimeout(() => {
  console.error("Conversation benchmark exceeded 45 seconds");
  void finish(1);
}, 45_000);

async function benchmark() {
  await app.whenReady();
  await runtime.start();
  const workspace = await runtime.request<{ id: string }>(RUNTIME_METHODS.addWorkspace, {
    path: path.join(scratch!, "workspace"),
  });
  const created = await requestSession<{ sessionId: string; accepted: boolean }>({
    host: {
      target: "codex",
      request: {
        operation: "create",
        workspaceId: workspace.id,
        deviceId: "conversation-benchmark-device",
        requestId: randomUUID(),
        policyId: "workspace-write-on-request",
        model: "mock-model",
        effort: "medium",
      },
    },
  });
  if (!created.accepted) throw new Error("Mock managed session creation was rejected");
  await service.initialize();
  const renderer = pathToFileURL(
    path.join(scratch!, "renderer/scripts/fixtures/conversation-benchmark/index.html"),
  );
  renderer.searchParams.set("sessionId", created.sessionId);
  window = new BrowserWindow({
    width: 1100,
    height: 850,
    show: true,
    webPreferences: {
      preload: path.join(scratch!, "bundle/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  registerConversationIpc({
    service,
    hub,
    assertTrustedRenderer(event) {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== renderer.href
      )
        throw new Error("Untrusted benchmark renderer");
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("console-message", (_event, _level, message) =>
    console.info(`renderer: ${message}`),
  );
  await window.loadURL(renderer.href);
  const samples = await window.webContents.executeJavaScript("window.conversationBenchmarkResult");
  const report = {
    ...samples,
    createdAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      cpu: os.cpus()[0]?.model,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      runtimeBuild: "TypeScript backend",
    },
    scope:
      "isolated Codex mock stdout → TypeScript backend → RuntimeRouter/DesktopRuntimeHost → ConversationHub → Electron IPC + production preload → EmbeddedConversation React DOM → double requestAnimationFrame",
    boundary:
      "Double rAF observes a Chromium rendering opportunity, not physical screen scanout. Local synthetic source only; no LAN, relay, real account or model generation benchmark.",
  };
  await writeFile(path.join(scratch!, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  clearTimeout(timeout);
  await finish(report.passed ? 0 : 1);
}
void benchmark().catch(async (error: unknown) => {
  console.error(error);
  clearTimeout(timeout);
  await finish(1);
});
