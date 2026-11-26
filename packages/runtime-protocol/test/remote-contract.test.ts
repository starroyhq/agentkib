import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CONVERSATION_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  REMOTE_CAPABILITIES,
  REMOTE_CONTRACT_VERSION,
  REMOTE_ERROR_CODES,
  REMOTE_ERROR_CONTRACT,
  REMOTE_FEATURE_VERSIONS,
  REMOTE_LEGACY_CODEX,
  REMOTE_MANAGED_ACTION_OPERATIONS,
  REMOTE_RECEIPT_ROUTE,
  REMOTE_REQUEST_PATH,
  REMOTE_ROUTE,
  REMOTE_ROUTE_BASE,
  REMOTE_ROUTE_SPECS,
  REMOTE_VERSIONS,
} from "../src/generated/remote-contract.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/remote-contract.json", import.meta.url), "utf8"),
);

test("the shared info and access responses negotiate current and legacy hosts", () => {
  assert.equal(fixture.contractVersion, REMOTE_CONTRACT_VERSION);
  assert.equal(PROTOCOL_VERSION, REMOTE_VERSIONS.runtime.minimum);
  assert.equal(CONVERSATION_PROTOCOL_VERSION, REMOTE_VERSIONS.conversation.minimum);
  for (const transport of ["local", "lan"]) {
    const info = fixture.info[transport];
    assert.equal(info.transport, transport);
    assert.equal(info.protocolVersion, REMOTE_VERSIONS.hostDiscovery.advertised);
    assert.ok(REMOTE_VERSIONS.hostDiscovery.accepted.includes(info.protocolVersion));
    assert.equal(info.conversationProtocolVersion, CONVERSATION_PROTOCOL_VERSION);
    assert.equal(info.capabilities[REMOTE_CAPABILITIES.info.read], true);
    assert.equal(typeof info.capabilities[REMOTE_CAPABILITIES.info.send], "boolean");
    assert.equal(typeof info.capabilities[REMOTE_CAPABILITIES.info.approve], "boolean");
  }
  for (const status of ["unpaired", "approved"]) {
    const access = fixture.access[status];
    assert.equal(access.status, status);
    assert.ok(access.csrfToken);
    assert.ok(access.bootId);
    assert.equal(access.protocolVersion, CONVERSATION_PROTOCOL_VERSION);
    assert.equal(
      access[REMOTE_CAPABILITIES.access.readStateVersion],
      REMOTE_FEATURE_VERSIONS.readStateVersion,
    );
  }
  assert.equal(
    fixture.access.approved[REMOTE_CAPABILITIES.access.pendingInteractions].version,
    REMOTE_FEATURE_VERSIONS.pendingInteractions,
  );
  assert.equal(
    fixture.access.approved[REMOTE_CAPABILITIES.access.taskSummaryVersion],
    REMOTE_FEATURE_VERSIONS.taskSummaryVersion,
  );
});

type IpcShape =
  | { kind: "none" | "transport" }
  | { kind: "rpc"; rpcCode: number; detail?: string }
  | { kind: "result"; field: string; reason: string; status?: number };

function assertIpc(shape: IpcShape, sample: unknown, code: string) {
  if (shape.kind === "none") {
    assert.equal(sample, undefined);
  } else if (shape.kind === "transport") {
    assert.deepEqual(sample, { error: code });
  } else {
    assert.ok(sample && typeof sample === "object");
    if (shape.kind === "rpc") {
      assert.ok("error" in sample && sample.error && typeof sample.error === "object");
      assert.ok("code" in sample.error);
      assert.equal(sample.error.code, shape.rpcCode);
      if (shape.detail) {
        assert.ok("data" in sample.error);
        assert.deepEqual(sample.error.data, { detail: shape.detail });
      }
    } else if (shape.kind === "result") {
      assert.ok("result" in sample);
      assert.deepEqual(sample.result, {
        [shape.field]: shape.reason,
        ...(shape.status === undefined ? {} : { status: shape.status }),
      });
    }
  }
}

test("every error has a shared response example for its HTTP and IPC representations", () => {
  const codes = Object.values(REMOTE_ERROR_CODES);
  assert.equal(new Set(codes).size, codes.length);
  assert.deepEqual(Object.keys(fixture.errors).sort(), Object.keys(REMOTE_ERROR_CONTRACT).sort());
  for (const key of Object.keys(REMOTE_ERROR_CONTRACT) as (keyof typeof REMOTE_ERROR_CONTRACT)[]) {
    const error = REMOTE_ERROR_CONTRACT[key];
    const sample = fixture.errors[key];
    assert.equal(error.code, REMOTE_ERROR_CODES[key]);
    if ("http" in error) {
      assert.deepEqual(
        sample.http,
        { status: error.http.status, body: { error: error.code } },
        key,
      );
      const overrides = "overrides" in error.http ? error.http.overrides : undefined;
      assert.deepEqual(sample.httpStatusOverrides, overrides, key);
    } else {
      assert.equal(sample.http, undefined, key);
    }
    assertIpc(error.ipc, sample.ipc, error.code);
    if ("additional" in error.ipc) {
      assert.deepEqual(Object.keys(sample.additionalIpc), Object.keys(error.ipc.additional));
      for (const [name, shape] of Object.entries(error.ipc.additional)) {
        assertIpc(shape, sample.additionalIpc[name], error.code);
      }
    }
  }
});

test("route declarations preserve LAN preflight and legacy Codex boundaries", () => {
  assert.equal(REMOTE_ROUTE_BASE, `/api/web/v${REMOTE_VERSIONS.remoteApi.major}`);
  for (const key of Object.keys(REMOTE_ROUTE) as (keyof typeof REMOTE_ROUTE)[]) {
    assert.equal("/" + REMOTE_REQUEST_PATH[key], REMOTE_ROUTE[key]);
  }
  assert.deepEqual(REMOTE_ROUTE_SPECS.GET[REMOTE_ROUTE.info], { lan: true });
  assert.deepEqual(REMOTE_ROUTE_SPECS.POST[REMOTE_ROUTE.managedAction], { control: true });
  assert.deepEqual(REMOTE_ROUTE_SPECS.POST[REMOTE_ROUTE.codexQueueDelete], {
    lan: true,
    control: true,
  });
  assert.equal(REMOTE_RECEIPT_ROUTE.lan, true);
  assert.equal(REMOTE_LEGACY_CODEX.nonControlPath, REMOTE_ROUTE.codexInspect);
  assert.equal(REMOTE_LEGACY_CODEX.postTarget, REMOTE_ROUTE.managedAction);
  assert.ok(REMOTE_LEGACY_CODEX.postOperations.includes("queue-delete"));
  for (const path of Object.keys(REMOTE_LEGACY_CODEX.getAliases)) {
    assert.ok(REMOTE_ROUTE_SPECS.GET[path]);
    assert.ok(REMOTE_ROUTE_SPECS.GET[REMOTE_LEGACY_CODEX.getAliases[path]!]);
  }
  for (const operation of [
    "delete",
    "compact",
    "terminals-clean",
    "usage-limit-cancel",
    "usage-limit-continue",
  ]) {
    assert.ok(REMOTE_MANAGED_ACTION_OPERATIONS.includes(operation));
    assert.ok(!REMOTE_LEGACY_CODEX.postOperations.includes(operation));
  }
});
