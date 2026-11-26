import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  readWindowsStoreIdentity,
  windowsStoreIdentityRequired,
} from "../../apps/desktop/scripts/package-windows-store.mjs";

test("Store package identity uses the exact values from Partner Center", () => {
  const environment = {
    WINDOWS_STORE_IDENTITY_NAME: "70000Example.AgentKib",
    WINDOWS_STORE_PUBLISHER: "CN=Example, O=Example, C=US",
    WINDOWS_STORE_PUBLISHER_DISPLAY_NAME: "Example & Company",
  };
  assert.deepEqual(readWindowsStoreIdentity(environment), {
    identityName: environment.WINDOWS_STORE_IDENTITY_NAME,
    publisher: environment.WINDOWS_STORE_PUBLISHER,
    publisherDisplayName: environment.WINDOWS_STORE_PUBLISHER_DISPLAY_NAME,
  });
  assert.throws(
    () => readWindowsStoreIdentity({ ...environment, WINDOWS_STORE_PUBLISHER_DISPLAY_NAME: "" }),
    /all three Windows Store identity variables/,
  );
  assert.throws(
    () => readWindowsStoreIdentity({ ...environment, WINDOWS_STORE_PUBLISHER: "Example" }),
    /invalid/,
  );
  assert.equal(readWindowsStoreIdentity({}), undefined);
});

test("a stable 1.x or later release requires an identity, and candidate or legacy builds may omit it", () => {
  for (const APP_VERSION of ["1.0.0", "2.4.0"]) {
    assert.equal(windowsStoreIdentityRequired({ APP_VERSION, SHOULD_PUBLISH: "true" }), true);
    assert.equal(windowsStoreIdentityRequired({ APP_VERSION, SHOULD_PUBLISH: "false" }), false);
  }
  for (const APP_VERSION of ["0.35.1", "1.0.0-rc.1"]) {
    assert.equal(windowsStoreIdentityRequired({ APP_VERSION, SHOULD_PUBLISH: "true" }), false);
  }
});

test("the publisher downloads direct desktop artifacts without the unsigned Store upload", async () => {
  const workflow = await readFile(
    new URL("../workflows/release-desktop.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /name: agentkib-windows-store-x64\r?\n/);
  assert.match(workflow, /pattern: agentkib-desktop-\*/);
});
