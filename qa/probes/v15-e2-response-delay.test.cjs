const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { delayPlanResponses } = require("./v15-e2-response-delay.cjs");

test("delays only an opted-in plan response and keeps original object identity", async () => {
  const child = new EventEmitter();
  const sent = [];
  child.postMessage = (value) => sent.push(value);
  delayPlanResponses(child, () => 20);
  const received = [];
  child.on("message", (value) => received.push(value));
  const request = { id: 1, method: "changes.plan", params: { synthetic: true } };
  const response = { id: 1, result: { files: [] } };
  const otherResponse = { id: 2, result: "unchanged" };
  child.postMessage(request);
  assert.equal(sent[0], request);
  child.emit("message", response);
  child.emit("message", otherResponse);
  assert.deepEqual(received, [otherResponse]);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(received[1], response);
});

test("disabled delay stays synchronous and exit drops pending timed deliveries", async () => {
  const child = new EventEmitter();
  child.postMessage = () => undefined;
  let delay = 0;
  delayPlanResponses(child, () => delay);
  const received = [];
  child.on("message", (value) => received.push(value));
  child.postMessage({ id: 1, method: "changes.plan" });
  const immediate = { id: 1, error: { code: -1 } };
  child.emit("message", immediate);
  assert.equal(received[0], immediate);
  delay = 20;
  child.postMessage({ id: 2, method: "changes.plan" });
  child.emit("message", { id: 2, result: null });
  child.emit("exit", 0);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(received, [immediate]);
});
