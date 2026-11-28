import assert from "node:assert/strict";
import test from "node:test";

import { hasLiveDesktopGroupMembers } from "./desktop-acceptance-launch.mjs";

test("acceptance cleanup allows a group with only exited members", () => {
  assert.equal(hasLiveDesktopGroupMembers(" 581 Z\n 581 Z+\n 5810 S\n 1581 R+\n", 581), false);
  assert.equal(hasLiveDesktopGroupMembers("", 581), false);
});

test("acceptance cleanup still waits if the isolated group has a live member", () => {
  assert.equal(hasLiveDesktopGroupMembers(" 581 Z+\n 581 S\n", 581), true);
  assert.equal(hasLiveDesktopGroupMembers(" 581 T+\n", 581), true);
});
