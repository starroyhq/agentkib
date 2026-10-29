"""One explicitly authorized official OpenCode reply in an EXISTING QA session.

Usage: python opencode-cpa-native-once-live.py EXISTING_CASE RUNTIME
Never run as a preparation check: this sends one real prompt if admitted.
The fixed per-case attempt directory and durable token must never be reset.
"""
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import stat
import subprocess
import sys
import time
import yaml
from datetime import datetime, timezone
from qa_owned_cli import run_owned_cli
from interop_native_readback import verify_native_source
from opencode_once_validation import validate_plan, validate_export

window_path = Path(os.environ["AGENTKIB_RETRY_WINDOW"]).resolve()
assert stat.S_ISREG(window_path.lstat().st_mode) and not window_path.is_symlink()
assert window_path.parent.stat().st_mode & 0o077 == 0
window = json.loads(window_path.read_text())
policy = {"requestRetry": 0, "maxRetryCredentials": 1, "streamBootstrapRetries": 0,
          "credentialOverrides": False, "ccSwitchRectifierEnabled": False, "ccSwitchAutoFailoverEnabled": False}
assert window["schemaVersion"] == 1 and window["status"] == "open"
assert window["endpoint"] == "http://127.0.0.1:8317" and window["model"] == "relay/claude-opus-5-5"
assert all(window["retryPolicy"].get(key) == value for key, value in policy.items())
assert (datetime.fromisoformat(window["expiresAt"].replace("Z", "+00:00")) - datetime.now(timezone.utc)).total_seconds() > 180
case, runtime = map(lambda p: Path(p).resolve(), sys.argv[1:])
attempt = case / "cpa-opus-once-2026-09-30"
if attempt.exists():
    raise SystemExit("Prior attempt exists; inspect evidence instead of retrying")
prior = json.loads((case / "result.json").read_text())
if prior["target"] != "opencode" or prior["first"]["status"] != "launched":
    raise SystemExit("Existing verified native OpenCode session required")
operation, = prior["operations"]
session = operation["target_session_id"]
plan_file, = (case / "data/continuations").rglob("plan.json")
plan = validate_plan(prior, plan_file.read_bytes(), json.loads(plan_file.with_name("receipt.json").read_text()),
    expected_model={"provider_id": "agentkib-cpa", "model_id": "relay/claude-opus-5-5"})
cli = plan["executable"]
workspace = Path(plan["workspace"])
env = json.loads((case / "environment.json").read_text())
verify_native_source(prior, env)
attempt.mkdir(mode=0o700)
source = Path(prior["source"])
assert hashlib.sha256(source.read_bytes()).hexdigest() == prior["sourceSha256"]
for metadata in prior.get("sourceMetadata", []):
    assert hashlib.sha256(Path(metadata["path"]).read_bytes()).hexdigest() == metadata["sha256"]
config = Path(env["XDG_CONFIG_HOME"]) / "opencode/opencode.json"
original_config = config.read_bytes()
(attempt / "original-config.json").write_bytes(original_config)
result = {"model": "agentkib-cpa/relay/claude-opus-5-5", "sessionId": session,
          "runtimeSha256": hashlib.sha256(runtime.read_bytes()).hexdigest(), "automaticRetriesPermitted": False}


def native(*args):
    reply = subprocess.run([cli, *args], env=env, cwd=workspace, capture_output=True, check=True, timeout=30)
    return json.loads(reply.stdout)



before = native("export", session)
(attempt / "before-export.json").write_text(json.dumps(before, indent=2))
sessions = native("session", "list", "--format", "json")
assert len(sessions) == 1 and sessions[0]["id"] == session
history = validate_export(plan, before)
prompt = "Recall the exact random marker and the complete project storage decision from our previous conversation. Reply with those two values only. Do not read files or use tools. The answers are intentionally absent from this message."
assert prior["marker"] not in prompt and prior["decision"] not in prompt
contract = attempt / "contract.json"
contract.write_text(json.dumps({"endpoint": "http://127.0.0.1:8317/v1/chat/completions", "model": "relay/claude-opus-5-5",
    "sessionId": session, "history": history, "prompt": prompt, "retryWindow": str(window_path)}, indent=2))
isolated_config = {"$schema": "https://opencode.ai/config.json", "model": "agentkib-cpa/relay/claude-opus-5-5", "small_model": "agentkib-cpa/relay/claude-opus-5-5",
    "enabled_providers": ["agentkib-cpa"], "autoupdate": False, "share": "disabled", "permission": "deny",
    "plugin": [str(Path(__file__).with_name("opencode-cpa-once-plugin.mjs"))],
    "provider": {"agentkib-cpa": {"npm": "@ai-sdk/openai-compatible", "name": "QA authorized CPA", "models": {"relay/claude-opus-5-5": {"name": "Selected Opus mapping", "limit": {"context": 200000, "output": 4096}}}, "options": {"baseURL": "http://127.0.0.1:9/blocked"}}},
    "agent": {"title": {"disable": True}, "compaction": {"disable": True}, "build": {"tools": {"*": False}}},
    "compaction": {"auto": False, "prune": False}}
modified = json.dumps(isolated_config).encode()
live_env = dict(env, AGENTKIB_QA_ONCE_CONTRACT=str(contract), OPENCODE_EXPERIMENTAL_NATIVE_LLM="false")
live_env.pop("AGENTKIB_QA_ONCE_OFFLINE", None)
# Read only the already-authorized client key, never provider auths or another Agent's credentials.
# This dictionary is never serialized. Actual source-key paths are checked against the active window.
try:
    cpa = yaml.safe_load(Path("/Users/user/proxy/CLIProxyAPI/config.yaml").read_text())
except yaml.YAMLError:
    raise SystemExit("CPA configuration is not valid YAML; refusing request") from None
assert cpa["routing"]["retry"]["request-retry"] == 0
assert cpa["routing"]["retry"]["max-retry-credentials"] == 1
assert cpa["requests"]["streaming"]["bootstrap-retries"] == 0
keys = cpa["access"]["api-keys"]
assert isinstance(keys, list) and len(keys) == 1 and isinstance(keys[0], str) and keys[0]
live_env["AGENTKIB_QA_CPA_API_KEY"] = keys[0]
live_env["OPENCODE_DISABLE_DEFAULT_PLUGINS"] = "true"
del keys, cpa
def guard_blocked():
    log = attempt / "guard-events.jsonl"
    events = [json.loads(row) for row in log.read_text().splitlines()] if log.exists() else []
    return any(event["event"] == "blocked" for event in events)

try:
    with (attempt / "run.stdout").open("w") as stdout, (attempt / "run.stderr").open("w") as stderr:
        run_owned_cli([cli, "run", "--session", session, "--model", "agentkib-cpa/relay/claude-opus-5-5", "--format", "json"],
            env=live_env, cwd=workspace, config=config, original=original_config, modified=modified, prompt=prompt,
            stdout=stdout, stderr=stderr, result=result, should_stop=guard_blocked)
finally:
    (attempt / "result.json").write_text(json.dumps(result, indent=2))

verify_native_source(prior, env)
after = native("export", session)
(attempt / "after-export.json").write_text(json.dumps(after, indent=2))
prefix_ok = after["messages"][:len(before["messages"])] == before["messages"]
assert prefix_ok, "Imported native history changed"
new_messages = after["messages"][len(before["messages"]):]
reply = "\n".join(part["text"] for row in new_messages if row["info"]["role"] == "assistant"
                  for part in row["parts"] if part["type"] == "text")
result.update(importedPrefixUnchanged=prefix_ok, reply=reply,
    markerMatched=prior["marker"] in reply, decisionMatched=prior["decision"].casefold() in reply.casefold(),
    sourceUnchanged=hashlib.sha256(source.read_bytes()).hexdigest() == prior["sourceSha256"],
    nativeSessionCount=len(native("session", "list", "--format", "json")),
    newUserTurns=sum(row["info"]["role"] == "user" for row in new_messages),
    usage=[{key: row["info"].get(key) for key in ("id", "modelID", "providerID", "tokens", "cost", "error")}
           for row in new_messages if row["info"]["role"] == "assistant"])
events = [json.loads(row) for row in (attempt / "guard-events.jsonl").read_text().splitlines()]
result["providerDispatches"] = sum(row["event"] == "dispatch" for row in events)
result["providerStatuses"] = [row["status"] for row in events if row["event"] == "response"]
assert result["providerDispatches"] <= 1 and result["newUserTurns"] == 1 and result["nativeSessionCount"] == 1
assert result["sourceUnchanged"]
result["sourceMetadataUnchanged"] = all(hashlib.sha256(Path(entry["path"]).read_bytes()).hexdigest() == entry["sha256"] for entry in prior.get("sourceMetadata", []))
assert result["sourceMetadataUnchanged"]
(attempt / "result.json").write_text(json.dumps(result, indent=2))

# Reopen AgentKib only after restoring the original isolated target config.
# The existing launched receipt prevents another import or terminal launch.
launch_request = None
for line in (case / "rpc.jsonl").read_text().splitlines():
    request = json.loads(line).get("request", {})
    if request.get("method") == "sessions.continueHandoff":
        launch_request = request["params"]
        break
assert launch_request is not None
rpc_child = subprocess.Popen([str(runtime)], env=env, cwd=workspace, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=(attempt / "runtime.stderr").open("w"))
seq, buffer = 0, b""


def rpc(method, params):
    global seq, buffer
    seq += 1
    rpc_child.stdin.write((json.dumps({"jsonrpc": "2.0", "id": seq, "method": method, "params": params}) + "\n").encode())
    rpc_child.stdin.flush()
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if b"\n" not in buffer:
            assert select.select([rpc_child.stdout], [], [], max(0, deadline - time.monotonic()))[0], "readonly RPC timeout"
            chunk = os.read(rpc_child.stdout.fileno(), 65536); assert chunk
            buffer += chunk
        line, buffer = buffer.split(b"\n", 1)
        row = json.loads(line)
        if row.get("id") == seq:
            assert "error" not in row, row
            return row["result"]
    raise TimeoutError("readonly RPC")


try:
    rpc("agentkib.handshake", {"protocolVersion": 15, "client": {"name": "interop-once-readonly", "version": "1"}})
    found = rpc("sessions.nativeImports", {"workspaceId": operation["launch_request"]["workspace_id"]})
    assert len(found) == 1 and found[0]["status"] == "launched" and found[0]["target_session_id"] == session
    assert found[0]["launch_request"]["operation_id"] == operation["launch_request"]["operation_id"]
    recovered = rpc("sessions.continueHandoff", launch_request)
    assert recovered["status"] == "launched", recovered
    result["runtimeExistingOperationReconciled"] = True
finally:
    try:
        if rpc_child.poll() is None:
            rpc("agentkib.shutdown", {})
            rpc_child.stdin.close(); rpc_child.wait(timeout=15)
    finally:
        if rpc_child.poll() is None:
            rpc_child.terminate()
            try:
                rpc_child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                rpc_child.kill(); rpc_child.wait()
        (attempt / "result.json").write_text(json.dumps(result, indent=2))
final = native("export", session)
assert final["messages"] == after["messages"], "Readonly Runtime recovery changed native history"
assert len(native("session", "list", "--format", "json")) == 1
result["readonlyRecoveryDidNotSendOrCreate"] = True
result["realReplyPassed"] = (result["markerMatched"] and result["decisionMatched"]
    and result["providerDispatches"] == 1 and result["providerStatuses"] == [200]
    and result["cliExitCode"] == 0 and all(not row["error"] for row in result["usage"]))
(attempt / "result.json").write_text(json.dumps(result, indent=2))
print(json.dumps(result))
