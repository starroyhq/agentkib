// Pure Node boundary tests. Does not load Electron, a profile, or a network service.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  OWNER,
  MODES,
  accountStatus,
  webStatus,
  nativeStatus,
  createBoundary,
} = require("./v15-c-fixtures.cjs");
function harness(
  mode = "first-time",
  original = async () => ({ privateStatus: "must not be returned" }),
) {
  let state = { owner: OWNER, mode, revision: 1 };
  const calls = [];
  const frame = {};
  const event = {
    senderFrame: frame,
    sender: { mainFrame: frame, getURL: () => "app://bundle/index.html#/settings" },
  };
  const boundary = createBoundary({
    readState: () => state,
    writeState: (next) => {
      state = next;
    },
    sessionId: "fixture-session",
  });
  return {
    event,
    calls,
    state: () => state,
    call: (channel, ...args) =>
      boundary(channel, async (...input) => {
        calls.push(input);
        return original(...input);
      })(event, ...args),
  };
}
test("all modes use public synthetic values and contain no usable credentials", () => {
  for (const mode of MODES) {
    const state = { owner: OWNER, mode };
    const local = webStatus(state);
    const lan = webStatus(state, "lan");
    assert.equal(
      local.config.relay?.brokerUrl,
      mode === "first-time"
        ? undefined
        : mode === "paused-signed-out"
          ? "https://api.agentkib.com"
          : "https://relay.example.invalid",
    );
    assert.equal(lan.addresses[0].address, "192.168.1.23");
    assert.equal(lan.running, false);
    assert.equal(lan.config.enabled, false);
    assert.equal(lan.config.allowPlaintext, false);
    assert.ok(
      !/credential|refreshToken|accessToken|ticket|socketPath/.test(JSON.stringify({ local, lan })),
    );
  }
  assert.equal(accountStatus({ owner: OWNER, mode: "first-time" }).phase, "signed-out");
  assert.equal(accountStatus({ owner: OWNER, mode: "paused-signed-out" }).phase, "signed-out");
  assert.equal(nativeStatus().local.enabled, false);
  assert.deepEqual(nativeStatus().connections, []);
});
test("remote discovery validates through the original status read and hides real interfaces", async () => {
  const h = harness();
  const status = await h.call("agentkib:remote:request", { operation: "discover" });
  assert.deepEqual(h.calls[0], [h.event, { operation: "status" }]);
  assert.deepEqual(status.interfaces, [{ name: "Example Wi-Fi", address: "192.168.1.23" }]);
  assert.equal(status.privateStatus, undefined);
});
test("name-only fixture saves cannot configure a real listener or accept other fields", async () => {
  const h = harness();
  const renamed = await h.call("agentkib:remote:request", {
    operation: "configure",
    name: "Example renamed computer",
    enabled: false,
    address: "127.0.0.1:42987",
  });
  assert.equal(renamed.local.name, "Example renamed computer");
  assert.equal(renamed.local.enabled, false);
  assert.equal(renamed.local.address, null);
  assert.deepEqual(h.calls[0], [h.event, { operation: "status" }]);
  for (const input of [
    { operation: "configure", name: "Example computer", enabled: true },
    { operation: "configure", name: "Example computer", address: "192.168.1.23:1420" },
    { operation: "configure", name: "Example computer", port: 1420 },
    { operation: "configure", name: "Example computer", enabled: false, address: "0.0.0.0:1420" },
    { operation: "configure", name: "" },
  ])
    await assert.rejects(h.call("agentkib:remote:request", input));
  assert.equal(h.calls.length, 1);
});
test("synthetic account data cannot bypass the original sender rejection", async () => {
  const h = harness("ready", async () => {
    throw new Error("original sender rejected");
  });
  await assert.rejects(
    h.call("agentkib:account:request", { operation: "status" }),
    /original sender rejected/,
  );
});
test("only the local top-level renderer can receive fixtures", async () => {
  const h = harness();
  h.event.senderFrame = {};
  await assert.rejects(
    h.call("agentkib:web:request", { operation: "status" }),
    /Local main frame required/,
  );
  assert.equal(h.calls.length, 0);
  h.event.senderFrame = h.event.sender.mainFrame;
  h.event.sender.getURL = () => "https://computer.example.invalid/";
  await assert.rejects(
    h.call("agentkib:web:request", { operation: "status" }),
    /Packaged local renderer required/,
  );
  assert.equal(h.calls.length, 0);
});
test("public access-code and pause actions perform reads and synthetic state changes only", async () => {
  const h = harness("ready");
  const code = await h.call("agentkib:web:request", { operation: "generate-code", access: "read" });
  assert.equal(code.code.value, "12345678");
  assert.equal(code.code.access, "read");
  assert.deepEqual(h.calls[0], [h.event, { operation: "status" }]);
  await h.call("agentkib:web:request", { operation: "relay-stop" });
  assert.equal(h.state().mode, "paused");
  assert.ok(h.calls.every(([, input]) => input.operation === "status"));
});
test("LAN status uses the original LAN read and does not issue access codes", async () => {
  const h = harness("ready");
  await h.call("agentkib:web:request", { operation: "status", target: "lan" });
  assert.deepEqual(h.calls[0], [h.event, { operation: "status", target: "lan" }]);
  await assert.rejects(
    h.call("agentkib:web:request", { operation: "generate-code", target: "lan" }),
    /blocks this action/,
  );
});
test("real account, bridge, model, session and remote mutations are never dispatched", async () => {
  const h = harness("ready");
  for (const [channel, input] of [
    ["agentkib:account:request", { operation: "login" }],
    ["agentkib:account:request", { operation: "logout" }],
    ["agentkib:claude:request", { operation: "send" }],
    ["agentkib:claude:request", { operation: "stop" }],
    ["agentkib:claude:request", { operation: "bridge-challenge" }],
    ["agentkib:claude:request", { operation: "model" }],
    ["agentkib:web:request", { operation: "remote-enable" }],
    ["agentkib:web:request", { operation: "configure" }],
    ["agentkib:remote:request", { operation: "configure" }],
    ["agentkib:remote:request", { operation: "pair" }],
    ["agentkib:shell:open-external", "https://example.invalid"],
    ["agentkib:home:add-scan-root", "/example"],
  ])
    await assert.rejects(h.call(channel, input), /blocks this action/);
  assert.equal(h.calls.length, 0);
});
test("does not accept credential fields even on a fixture read", async () => {
  const h = harness("ready");
  await assert.rejects(
    h.call("agentkib:web:request", { operation: "status", ticket: "PUBLIC-PLACEHOLDER" }),
    /Unexpected visual fixture input/,
  );
  assert.equal(h.calls.length, 0);
});
test("read handlers run intact and conversation mutation or model routes are blocked", async () => {
  const h = harness("ready", async () => ({ status: 200 }));
  assert.deepEqual(await h.call("agentkib:home:runtime"), { status: 200 });
  assert.deepEqual(await h.call("agentkib:conversation:request", "/catalog"), { status: 200 });
  for (const args of [["/send", {}], ["/stop", {}], ["/models"], ["/live?sessionId=other-session"]])
    await assert.rejects(h.call("agentkib:conversation:request", ...args), /blocks this action/);
  assert.equal(h.calls.length, 2);
});

test("renderer reload can read runtime status without allowing runtime retry", async () => {
  const h = harness("first-time", async () => ({ phase: "ready" }));
  assert.deepEqual(await h.call("agentkib:runtime:status"), { phase: "ready" });
  await assert.rejects(h.call("agentkib:runtime:retry"), /blocks this action/);
  assert.equal(h.calls.length, 1);
});

test("first-time config omits relay while a saved pause retains its relay settings", () => {
  const first = webStatus({ owner: OWNER, mode: "first-time" });
  assert.equal(Object.hasOwn(first.config, "relay"), false);
  assert.equal(webStatus({ owner: OWNER, mode: "first-time" }, "lan").config.lanAddress, "");
  for (const mode of MODES.filter((mode) => mode !== "first-time")) {
    const saved = webStatus({ owner: OWNER, mode });
    assert.equal(
      saved.config.relay.brokerUrl,
      mode === "paused-signed-out" ? "https://api.agentkib.com" : "https://relay.example.invalid",
    );
    assert.equal(saved.config.relay.enabled, !["paused", "paused-signed-out"].includes(mode));
  }
});
