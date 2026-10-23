// Transparent QA transport timing only: preserve every original request and response object.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function installPlanResponseDelay(utilityProcess, root) {
  const originalFork = utilityProcess.fork;
  const controlFile = path.join(root, "plan-response-delay.json");
  const readDelay = () => {
    if (!fs.existsSync(controlFile)) return 0;
    assert.ok(!fs.lstatSync(controlFile).isSymbolicLink());
    assert.equal(fs.realpathSync(path.dirname(controlFile)), root);
    const { milliseconds } = JSON.parse(fs.readFileSync(controlFile, "utf8"));
    assert.ok(Number.isInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 5000);
    return milliseconds;
  };
  utilityProcess.fork = function (executablePath, ...args) {
    const child = originalFork.call(this, executablePath, ...args);
    if (path.basename(executablePath) !== "backend.cjs") return child;
    delayPlanResponses(child, readDelay);
    return child;
  };
}

function delayPlanResponses(child, readDelay) {
  const originalPost = child.postMessage;
  const originalEmit = child.emit;
  const pending = new Map();
  const timers = new Set();
  child.postMessage = function (request, ...args) {
    if (request?.method === "changes.plan") {
      const delay = readDelay();
      if (delay > 0) pending.set(request.id, delay);
    }
    return originalPost.call(this, request, ...args);
  };
  child.emit = function (event, message, ...args) {
    if (event === "message" && message?.id !== undefined && pending.has(message.id)) {
      const delay = pending.get(message.id);
      pending.delete(message.id);
      const timer = setTimeout(() => {
        timers.delete(timer);
        originalEmit.call(child, event, message, ...args);
      }, delay);
      timers.add(timer);
      return true;
    }
    if (event === "exit") {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      pending.clear();
    }
    return originalEmit.call(this, event, message, ...args);
  };
}

module.exports = { installPlanResponseDelay, delayPlanResponses };
