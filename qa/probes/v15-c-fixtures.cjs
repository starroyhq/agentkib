// Public synthetic display data only. No value in this module is a usable credential.
const assert = require("node:assert/strict");
const OWNER = "agentkib-v15-c-sandbox";
const MODES = [
  "first-time",
  "registering",
  "ready",
  "code",
  "offline",
  "failed",
  "paused",
  "paused-signed-out",
];
const INTERFACE = { name: "Example Wi-Fi", address: "192.168.1.23" };
const BROKER = "https://relay.example.invalid";
const PUBLIC_URL = "https://computer.example.invalid";
const BROWSER = "fixture-browser-1";
const denied = () => {
  throw new Error("Synthetic visual QA blocks this action");
};

function validateState(state) {
  assert.equal(state?.owner, OWNER, "Unowned visual fixture state");
  assert.ok(MODES.includes(state.mode), "Unknown visual fixture mode");
  assert.ok(state.access === undefined || ["full", "read"].includes(state.access));
  assert.ok(
    state.nativeName === undefined ||
      (typeof state.nativeName === "string" && /^[^\r\n]{1,64}$/.test(state.nativeName)),
    "Invalid synthetic computer name",
  );
  return state;
}
function accountStatus(state) {
  validateState(state);
  return ["first-time", "paused-signed-out"].includes(state.mode)
    ? { phase: "signed-out", secureStorage: true }
    : {
        phase: "signed-in",
        secureStorage: true,
        account: {
          id: "fixture-account",
          username: "reader@example.invalid",
          status: "active",
          deviceLimit: 3,
          deviceCount: 1,
          totpEnabled: true,
        },
        device: { deviceId: "fixture-computer", ownership: "owned" },
      };
}
function webStatus(state, target) {
  validateState(state);
  const lan = target === "lan";
  const enabled = !lan && !["first-time", "paused", "paused-signed-out"].includes(state.mode);
  const ready = enabled && ["ready", "code"].includes(state.mode);
  const access = state.access ?? "full";
  return {
    pairingMode: lan ? "confirmation" : "code",
    mode: lan ? "lan" : "local",
    config: {
      enabled,
      port: lan ? 1422 : 1421,
      externalOrigin: lan ? "https://remote.agentkib.com" : ready ? PUBLIC_URL : "",
      experimentalEnabled: false,
      ...(lan
        ? {
            lanAddress: state.mode === "first-time" ? "" : INTERFACE.address,
            allowPlaintext: false,
          }
        : {
            allowedWorkspaceIds: [],
            extraRoots: [],
            previewBytesPerSecond: 2 * 1024 * 1024,
            ...(state.mode === "first-time"
              ? {}
              : {
                  relay: {
                    enabled,
                    brokerUrl:
                      state.mode === "paused-signed-out" ? "https://api.agentkib.com" : BROKER,
                  },
                }),
          }),
    },
    running: enabled,
    localUrl: lan ? `http://${INTERFACE.address}:1422` : "http://127.0.0.1:1421",
    experimentalAvailable: true,
    ...(lan
      ? { addresses: [INTERFACE] }
      : {
          relay: {
            phase: !enabled
              ? "disabled"
              : ready
                ? "ready"
                : state.mode === "registering"
                  ? "registering"
                  : state.mode === "offline"
                    ? "offline"
                    : "error",
            ...(ready ? { publicUrl: PUBLIC_URL, channels: { control: true, preview: true } } : {}),
            ...(state.mode === "offline"
              ? { reason: "network", retryAt: Date.now() + 60_000 }
              : {}),
            ...(state.mode === "failed"
              ? { reason: "connector", failure: { stage: "control-connector", code: "process" } }
              : {}),
          },
        }),
    ...(state.mode === "code" && !lan
      ? {
          code: { value: "12345678", expiresAt: state.expiresAt ?? Date.now() + 300_000, access },
        }
      : {}),
    pending: [],
    devices:
      ready && state.mode !== "code" && !state.revoked && !lan
        ? [
            {
              id: BROWSER,
              name: "Example phone",
              accessMode: "full",
              accessLevel: access,
              send: access === "full",
              approve: access === "full",
              manage: access === "full",
              files: true,
              attachments: access === "full",
              advancedControl: access === "full",
              organize: access === "full",
              settings: access === "full",
              extendedApproval: access === "full",
              createdAt: Date.UTC(2026, 9, 22, 1),
            },
          ]
        : [],
  };
}
function nativeStatus(state) {
  return {
    local: {
      id: "fixture-computer",
      name: state?.nativeName ?? "Example computer",
      enabled: false,
      address: null,
    },
    interfaces: [INTERFACE],
    discovered: [],
    pending: [],
    authorized: [],
    connections: [],
    pairing_code: null,
    pairing_expires_at: null,
  };
}
const READ_CHANNELS = new Set([
  "agentkib:runtime:status",
  "agentkib:home:runtime",
  "agentkib:home:workspaces",
  "agentkib:home:agent-installations",
  "agentkib:home:activity",
  "agentkib:home:catalog-assets",
  "agentkib:home:global-memories",
  "agentkib:home:scan-roots",
  "agentkib:home:discovery-report",
  "agentkib:home:excluded-workspaces",
  "agentkib:home:remote-gateways",
  "agentkib:home:insights-view",
  "agentkib:home:insights-summary",
  "agentkib:home:insights-status",
  "agentkib:home:quota-collector-status",
  "agentkib:home:quota-snapshot",
  "agentkib:home:quota-preferences",
  "agentkib:home:refresh-status",
  "agentkib:home:storage-overview",
  "agentkib:workspace:sessions",
  "agentkib:workspace:session-status",
  "agentkib:workspace:doctor-summaries",
  "agentkib:workspace:doctor-report",
  "agentkib:session:events",
  "agentkib:session:source-capability",
  "agentkib:session:native-imports",
  "agentkib:skills:catalog",
  "agentkib:skills:installed",
  "agentkib:skills:inventory",
  "agentkib:skills:targets",
  "agentkib:mcp:management-state",
  "agentkib:mcp:hub-status",
  "agentkib:conversation:acknowledge",
  "agentkib:conversation:unsubscribe",
  "agentkib:conversation:cancel-read",
  "agentkib:updates:check",
]);
function assertLocalMainFrame(event) {
  assert.ok(
    event?.sender && event.senderFrame === event.sender.mainFrame,
    "Local main frame required",
  );
  const url = new URL(event.sender.getURL());
  assert.equal(url.protocol, "app:", "Packaged local renderer required");
  assert.equal(url.host, "bundle", "Local renderer bundle required");
}
function createBoundary({ readState, writeState, sessionId }) {
  return (channel, handler) =>
    async (event, ...args) => {
      if (
        ["agentkib:account:request", "agentkib:web:request", "agentkib:remote:request"].includes(
          channel,
        )
      ) {
        const input = args[0];
        assert.ok(input && typeof input === "object" && !Array.isArray(input));
        if (channel === "agentkib:account:request" && input.operation !== "status") return denied();
        if (
          channel === "agentkib:remote:request" &&
          !["status", "discover", "configure"].includes(input.operation)
        )
          return denied();
        if (
          channel === "agentkib:web:request" &&
          !["status", "generate-code", "relay-stop", "set-access", "revoke"].includes(
            input.operation,
          )
        )
          return denied();
        const fields =
          channel !== "agentkib:web:request"
            ? [
                "operation",
                ...(channel === "agentkib:remote:request" && input.operation === "configure"
                  ? ["name", "enabled", "address"]
                  : []),
              ]
            : [
                "operation",
                "target",
                ...(["set-access", "revoke"].includes(input.operation) ? ["id"] : []),
                ...(["set-access", "generate-code"].includes(input.operation) ? ["access"] : []),
              ];
        assert.ok(
          Object.keys(input).every((field) => fields.includes(field)),
          "Unexpected visual fixture input",
        );
        if (channel === "agentkib:remote:request" && input.operation === "configure")
          assert.ok(
            typeof input.name === "string" && /^[^\r\n]{1,64}$/.test(input.name),
            "Synthetic visual QA blocks this action",
          );
        if (channel === "agentkib:remote:request" && input.operation === "configure")
          assert.ok(
            input.enabled === false &&
              ["127.0.0.1:42987", `${INTERFACE.address}:42987`].includes(input.address),
            "Synthetic visual QA blocks this action",
          );
        assertLocalMainFrame(event);
        // Always run the corresponding production read first. It enforces renderer
        // ownership and target checks; no production mutation is ever dispatched.
        await handler(event, {
          operation: "status",
          ...(input.target === undefined ? {} : { target: input.target }),
        });
        const state = validateState(readState());
        if (channel === "agentkib:remote:request") {
          if (input.operation === "configure") writeState({ ...state, nativeName: input.name });
          return nativeStatus(readState());
        }
        if (channel === "agentkib:account:request") return accountStatus(state);
        assert.ok(input.target === undefined || input.target === "lan");
        if (input.operation === "generate-code") {
          if (input.target === "lan" || !["ready", "code"].includes(state.mode)) return denied();
          assert.ok(input.access === undefined || ["read", "full"].includes(input.access));
          writeState({
            ...state,
            mode: "code",
            access: input.access ?? "full",
            expiresAt: Date.now() + 300_000,
          });
        } else if (input.operation === "relay-stop") {
          if (input.target === "lan") return denied();
          writeState({ ...state, mode: "paused" });
        } else if (["set-access", "revoke"].includes(input.operation)) {
          if (input.target === "lan" || input.id !== BROWSER) return denied();
          if (input.operation === "set-access") {
            assert.ok(["read", "full"].includes(input.access));
            writeState({ ...state, access: input.access });
          } else writeState({ ...state, revoked: true });
        }
        return webStatus(readState(), input.target);
      }
      if (channel === "agentkib:conversation:request") {
        if (args[1] !== undefined || typeof args[0] !== "string") return denied();
        const route = new URL(args[0], "http://127.0.0.1");
        if (!/^(?:\/api\/web\/v1)?\/(?:catalog|history\/catalog|live|events)$/.test(route.pathname))
          return denied();
        const selected = route.searchParams.get("sessionId");
        if (selected && selected !== sessionId) return denied();
        return handler(event, ...args);
      }
      if (channel === "agentkib:conversation:subscribe") {
        if (args[0] !== sessionId) return denied();
        return handler(event, ...args);
      }
      if (READ_CHANNELS.has(channel)) return handler(event, ...args);
      return denied();
    };
}
module.exports = {
  OWNER,
  MODES,
  INTERFACE,
  BROKER,
  PUBLIC_URL,
  validateState,
  accountStatus,
  webStatus,
  nativeStatus,
  createBoundary,
};
