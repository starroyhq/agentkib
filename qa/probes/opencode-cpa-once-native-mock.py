"""Exercise the official pinned OpenCode CLI with a loopback-only 500 fixture.

Usage: python opencode-cpa-once-native-mock.py OPENCODE EXISTING_EXPORT NEW_CASE
No upstream provider is contacted. The imported synthetic history is copied into
a new HOME; the official CLI is not patched.
"""
import http.server
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

cli, exported, case = map(lambda p: Path(p).resolve(), sys.argv[1:4])
mode = sys.argv[4] if len(sys.argv) > 4 else "500"
if case.exists():
    raise SystemExit("Case must be new")
case.mkdir(mode=0o700, parents=True)
workspace = case / "workspace"
workspace.mkdir()
requests = []
request_paths = []


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["content-length"]))
        assert self.headers.get("Authorization") == "Bearer mock-only-credential-not-real"
        assert not self.headers.get("x-opencode-client")
        requests.append(json.loads(body))
        request_paths.append(self.path)
        if mode == "network":
            self.connection.shutdown(2)
            self.connection.close()
            return
        if mode == "redirect":
            self.send_response(307)
            self.send_header("location", f"http://127.0.0.1:{self.server.server_port}/redirect-target")
            self.end_headers()
            return
        if mode == "stream":
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("content-length", "99999")
            self.end_headers()
            self.wfile.write(b'data: {"id":"x","choices":[]}\n\n')
            self.wfile.flush()
            self.connection.shutdown(2)
            self.connection.close()
            return
        self.send_response(429 if mode == "429" else 500)
        self.send_header("content-type", "application/json")
        self.send_header("retry-after", "0")
        self.end_headers()
        self.wfile.write(b'{"error":{"message":"controlled mock failure"}}')

    def log_message(self, *_args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
endpoint = f"http://127.0.0.1:{server.server_port}/v1/chat/completions"
native = json.loads(exported.read_text())
native["info"]["directory"] = str(workspace)
native["info"]["title"] = "Synthetic imported history guard fixture"
for row in native["messages"]:
    if "path" in row["info"]:
        row["info"]["path"] = {"cwd": str(workspace), "root": str(workspace)}
payload = case / "import.json"
payload.write_text(json.dumps(native))
history = [{"role": m["info"]["role"], "text": "\n".join(p["text"] for p in m["parts"] if p["type"] == "text")}
           for m in native["messages"]]
prompt = "Recall the random marker and project decision from the previous history. Answer only those values. Do not use tools."
contract = case / "contract.json"
contract.write_text(json.dumps(dict(endpoint=endpoint, model="relay/claude-opus-5-5", sessionId=native["info"]["id"], history=history, prompt=prompt)))
env = {"PATH": "/opt/homebrew/bin:/usr/bin:/bin", "HOME": str(case / "home"), "TERM": "xterm-256color",
       "OPENCODE_DISABLE_AUTOUPDATE": "true", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true",
       "OPENCODE_DISABLE_MODELS_FETCH": "true", "AGENTKIB_QA_ONCE_CONTRACT": str(contract),
       "AGENTKIB_QA_CPA_API_KEY": "mock-only-credential-not-real", "AGENTKIB_QA_ONCE_OFFLINE": "1", "OPENCODE_EXPERIMENTAL_NATIVE_LLM": "false"}
for name in ("DATA", "CONFIG", "STATE", "CACHE"):
    env[f"XDG_{name}_HOME"] = str(case / name.lower())
config = case / "config/opencode/opencode.json"
config.parent.mkdir(parents=True)
config.write_text(json.dumps({"model": "agentkib-cpa/relay/claude-opus-5-5", "enabled_providers": ["agentkib-cpa"], "autoupdate": False, "share": "disabled",
    "permission": "deny", "plugin": [str(Path(__file__).with_name("opencode-cpa-once-plugin.mjs"))],
    "provider": {"agentkib-cpa": {"npm": "@ai-sdk/openai-compatible", "name": "QA authorized CPA", "models": {"relay/claude-opus-5-5": {"name": "Selected Opus mapping", "limit": {"context": 200000,"output":4096}}}, "options": {"baseURL": "http://127.0.0.1:9/blocked"}}},
    "agent": {"title": {"disable": True}, "compaction": {"disable": True},
              "build": {"tools": {"*": False}}}, "compaction": {"auto": False, "prune": False}}))
subprocess.run([str(cli), "import", str(payload)], env=env, cwd=workspace, check=True,
               stdout=(case / "import.stdout").open("w"), stderr=(case / "import.stderr").open("w"), timeout=45)
if mode in ("missing-plugin", "throw-plugin", "throw-config"):
    bad = case / "bad-plugin.mjs"
    if mode == "throw-plugin":
        bad.write_text('export const Bad = async () => { throw Error("fixture plugin failure"); };')
    elif mode == "throw-config":
        bad.write_text('export const Bad = async () => ({config: async () => { throw Error("fixture config failure"); }});')
    changed = json.loads(config.read_text()); changed["plugin"] = [str(bad)]; config.write_text(json.dumps(changed))
child = subprocess.Popen([str(cli), "run", "--session", native["info"]["id"], "--model", "agentkib-cpa/relay/claude-opus-5-5", "--format", "json"],
    env=env, cwd=workspace, stdin=subprocess.PIPE, stdout=(case / "run.stdout").open("w"), stderr=(case / "run.stderr").open("w"), start_new_session=True)
child.stdin.write(prompt.encode()); child.stdin.close()
deadline = time.monotonic() + 25
guard_events = []
try:
    while child.poll() is None and time.monotonic() < deadline:
        events = case / "guard-events.jsonl"
        guard_events = [json.loads(row) for row in events.read_text().splitlines()] if events.exists() else []
        if any(e["event"] == "blocked" for e in guard_events):
            break
        threading.Event().wait(0.05)
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    server.shutdown()
    server.server_close()
    result = {"mode": mode, "nativeMockRequests": len(requests), "requestPaths": request_paths, "guardEvents": guard_events,
              "nativeCliVersion": "1.18.32", "realModelRequests": 0, "exitAfterCleanup": child.returncode}
    (case / "result.json").write_text(json.dumps(result, indent=2))
if mode in ("missing-plugin", "throw-plugin", "throw-config"):
    assert len(requests) == 0, result
else:
    assert len(requests) == 1, result
    assert request_paths == ["/v1/chat/completions"], result
    assert (case / "dispatch-token.json").is_file(), result
    assert sum(e["event"] == "dispatch" for e in guard_events) == 1, result
    if mode in ("500", "429"):
        assert any(e["event"] == "blocked" for e in guard_events), result
for path in case.rglob("*"):
    if path.is_file():
        marker = b"mock-only-credential-not-real"
        overlap = b""
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                combined = overlap + chunk
                assert marker not in combined, ("credential persisted", str(path))
                overlap = combined[-len(marker):]
result["processCredentialNotPersisted"] = True
(case / "result.json").write_text(json.dumps(result, indent=2))
print(json.dumps(result))
