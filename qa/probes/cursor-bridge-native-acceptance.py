#!/usr/bin/env python3
"""Real Cursor GUI + production Runtime acceptance; no model or Cursor DB writes.

prepare --runtime PATH creates fresh evidence and isolated synthetic Claude sources.
serve keeps that frozen Runtime alive. send --json '{"action":"status","workspace":"a"}'
or send --file COMMAND.json controls it through a private local Unix socket.
serve --stdin also accepts one JSON command per stdin line. Challenges are never
returned on stdout or logged: only an exclusive 0600 local temporary file.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid

ROOT = Path("/Users/user/.codex/tmp/cursor-bridge-1001")
EVIDENCE = Path("/Users/user/Documents/AgentKib-archives/2026-10-01/interop-closeout/cursor-native")
MAX_FRAME = 128 * 1024 * 1024
SENSITIVE = {"challenge", "ticket", "credential", "credentialhash", "authorization", "apikey", "password", "token"}
CURSOR_PACKAGE_SHA256 = "0f043db2fd6975bb60045dcc93a8e402e3dfc1d55aa753e0433067f8b79563fb"
CURSOR_BINARY_SHA256 = "7c85e27a23b7dbe8fbfc738a8876550b10cd57173df7cf7d060de69bb216a075"
VERIFIED_APP_ROOTS = (
    "/Applications/Cursor.app/Contents/Resources/app",
    "/Users/user/.codex/tmp/cursor-native-app-1001/Cursor.app/Contents/Resources/app",
)


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe(value):
    if isinstance(value, dict):
        return {key: "[redacted]" if key.lower().replace("_", "").replace("-", "") in SENSITIVE else safe(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [safe(item) for item in value]
    return value


def private_json(path, value, exclusive=False):
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC) | os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.write("\n")


def canonical(path):
    path = Path(path).absolute()
    check(not any(p.is_symlink() for p in (path, *path.parents)), "Links are forbidden in acceptance paths")
    return path.resolve()


def validate_fixture_name(fixture_name):
    check(fixture_name.startswith("harness") and len(fixture_name) <= 64 and
          all(char.isascii() and (char.isalnum() or char == '-') for char in fixture_name),
          "Fixture name must be a bounded harness directory name")


def vendor_import_root(root):
    def encode(value):
        out = bytearray()
        while value >= 128:
            out.append((value & 127) | 128)
            value >>= 7
        out.append(value)
        return bytes(out)

    def read(offset):
        start, value = offset, 0
        for shift in range(0, 70, 7):
            check(offset < len(root), "Truncated reviewed root varint")
            byte = root[offset]
            offset += 1
            value |= (byte & 127) << shift
            if byte < 128:
                check(value < 2**64 and root[start:offset] == encode(value), "Nonminimal reviewed root varint")
                return value, offset
        raise RuntimeError("Reviewed root varint exceeds bound")

    groups, offset = {1: [], 8: [], 9: []}, 0
    while offset < len(root):
        start = offset
        tag, offset = read(offset)
        number = tag >> 3
        check(number in groups and tag & 7 == 2, "Unverified reviewed root field/wire")
        length, offset = read(offset)
        check(length <= len(root) - offset, "Truncated reviewed root value")
        value = root[offset:offset + length]
        offset += length
        check(number == 9 or length == 32, "Invalid reviewed root reference")
        if number == 9:
            check(value.decode("utf8").startswith("file:///"), "Invalid reviewed workspace URI")
        groups[number].append(root[start:offset])
    check(len(groups[9]) == 1, "Reviewed root workspace must be unique")
    return b"".join(record for number in (1, 8, 9) for record in groups[number])


def prepare(args):
    root, evidence, runtime = canonical(args.root), canonical(args.evidence), canonical(args.runtime)
    fixture_name = args.fixture_name
    validate_fixture_name(fixture_name)
    # macOS sockaddr_un.sun_path includes a terminating NUL in 104 bytes.
    # Reject before creating an otherwise unusable fixture/receipt directory.
    check(len(os.fsencode(root / fixture_name / "control.sock")) <= 103,
          "Control socket path exceeds the macOS Unix socket limit")
    check(not evidence.exists(), "Evidence must be new; previous results are never overwritten")
    check(not (root / fixture_name).exists(), "Harness fixture must be new")
    root.mkdir(parents=True, exist_ok=True)
    evidence.mkdir(parents=True, mode=0o700)
    fixture = root / fixture_name
    fixture.mkdir(mode=0o700)
    (fixture / "challenges").mkdir(mode=0o700)
    (evidence / "tools").mkdir(mode=0o700)
    check(runtime.is_file(), "Runtime binary is missing")
    runtime_hash = sha(runtime.read_bytes())
    frozen = evidence / "tools/agentkib-runtime"
    shutil.copyfile(runtime, frozen)
    frozen.chmod(0o700)
    check(sha(frozen.read_bytes()) == runtime_hash == sha(runtime.read_bytes()), "Runtime changed during freeze")
    env = {"PATH": "", "LANG": "en_US.UTF-8", "HOME": str(fixture / "home"),
           "AGENTKIB_BENCHMARK_DATA_DIR": str(fixture / "data"),
           "CLAUDE_CONFIG_DIR": str(fixture / "claude"), "CODEX_HOME": str(fixture / "codex"),
           "GROK_HOME": str(fixture / "grok"), "CURSOR_CONFIG_DIR": str(fixture / "cursor-cli"),
           "HERMES_HOME": str(fixture / "hermes"), "OPENCLAW_STATE_DIR": str(fixture / "openclaw"),
           "OPENCLAW_CONFIG_PATH": str(fixture / "openclaw/openclaw.json"),
           "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"}
    for name in ("DATA", "CONFIG", "STATE", "CACHE"):
        env[f"XDG_{name}_HOME"] = str(fixture / name.lower())
    for key, value in env.items():
        if key.endswith("_HOME") or key in ("HOME", "AGENTKIB_BENCHMARK_DATA_DIR", "CLAUDE_CONFIG_DIR", "CURSOR_CONFIG_DIR", "OPENCLAW_STATE_DIR"):
            Path(value).mkdir(parents=True, exist_ok=True, mode=0o700)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    private_json(fixture / "data/preferences.json", {"mcp_network": {"port": port, "lan_enabled": False, "lan_risk_accepted": False}})
    cases = {}
    for label in ("a", "b"):
        workspace = root / f"workspace-{label}"
        workspace.mkdir(exist_ok=True)
        check(workspace.is_dir() and not workspace.is_symlink(), "Workspace must be an ordinary directory")
        source_id, marker = str(uuid.uuid4()), "AKIB-CURSOR-" + uuid.uuid4().hex[:18]
        messages = [("user", f"Remember {marker}. Decision: append-only SQLite WAL with namespace cobalt-lake.\n工作区 {label}：完整保留 UTF-8 与换行。"),
                    ("assistant", f"Recorded {marker}; append-only SQLite WAL with namespace cobalt-lake.\n完整历史：第一轮。"),
                    ("user", f"For {marker}, restate the selected storage decision without changing namespace.\nLiteral code: `SELECT 1;`"),
                    ("assistant", f"{marker}\nappend-only SQLite WAL with namespace cobalt-lake\n历史已保留；没有执行代码。")]
        rows, parent = [], None
        for role, content in messages:
            turn_id = str(uuid.uuid4())
            rows.append({"type": role, "uuid": turn_id, "parentUuid": parent, "sessionId": source_id,
                         "cwd": str(workspace), "timestamp": "2026-10-01T00:00:00.000Z",
                         "message": {"role": role, "content": content}})
            parent = turn_id
        source = fixture / "claude/projects" / f"synthetic-{label}" / (source_id + ".jsonl")
        source.parent.mkdir(parents=True, mode=0o700)
        with source.open("x") as output:
            output.write("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))
        source.chmod(0o600)
        cases[label] = {"workspace": str(workspace), "source": str(source), "source_native_id": source_id,
                        "source_sha256": sha(source.read_bytes()), "marker": marker, "messages": messages}
    manifest = {"root": str(root), "evidence": str(evidence), "fixture": str(fixture), "runtime": str(frozen),
                "runtime_original": str(runtime), "runtime_sha256": runtime_hash, "env": env, "cases": cases,
                "cursor_userdata": str(root), "cursor_extensions": "/Users/user/.codex/tmp/cursor-bridge-ext-1001",
                "control_socket": str(fixture / "control.sock"), "no_model_calls": True, "no_cursor_database_writes": True}
    private_json(evidence / "manifest.json", manifest, True)
    private_json(evidence / "state.json", {"cases": cases, "attempts": {}}, True)
    print(json.dumps({"prepared": True, "runtime_sha256": runtime_hash, "workspaces": {k: v["workspace"] for k, v in cases.items()},
                      "control_socket": manifest["control_socket"], "manifest": str(evidence / "manifest.json")}, ensure_ascii=False))


class Runtime:
    def __init__(self, manifest, log):
        generations = [int(path.stem.split("-")[1]) for path in Path(manifest["evidence"]).glob("runtime-*-stderr.json")]
        self.manifest, self.log, self.sequence, self.generation, self.process, self.pending = manifest, log, 0, max(generations, default=0), None, b""

    def start(self):
        check(self.process is None, "Runtime already started")
        check(sha(Path(self.manifest["runtime"]).read_bytes()) == self.manifest["runtime_sha256"], "Frozen Runtime hash changed")
        self.generation += 1
        self.process = subprocess.Popen([self.manifest["runtime"]], cwd=self.manifest["cases"]["a"]["workspace"],
                                        env=self.manifest["env"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, start_new_session=True)
        # Production stderr is operational text; keep only its digest/byte count, never raw credentials.
        process, generation = self.process, self.generation
        def drain():
            digest, count = hashlib.sha256(), 0
            while chunk := process.stderr.read(65536):
                digest.update(chunk)
                count += len(chunk)
            private_json(Path(self.manifest["evidence"]) / f"runtime-{generation:02d}-stderr.json",
                         {"sha256": digest.hexdigest(), "bytes": count, "raw_stderr_not_saved": True})
        threading.Thread(target=drain, daemon=True).start()
        self.log({"event": "runtime-start", "generation": generation, "pid": self.process.pid,
                  "sha256": self.manifest["runtime_sha256"], "harness_sha256": sha(Path(__file__).read_bytes())})
        return self.rpc("agentkib.handshake", {"protocolVersion": 15, "client": {"name": "cursor-native-acceptance", "version": "1"}})

    def rpc(self, method, params, challenge=False):
        check(self.process is not None and self.process.poll() is None, "Runtime is not running")
        self.sequence += 1
        request_id = self.sequence
        request = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        self.log({"direction": "request", "generation": self.generation, "frame": safe(request)})
        self.process.stdin.write((json.dumps(request, ensure_ascii=False) + "\n").encode())
        self.process.stdin.flush()
        deadline = time.monotonic() + 190
        while True:
            while b"\n" in self.pending:
                line, self.pending = self.pending.split(b"\n", 1)
                response = json.loads(line)
                self.log({"direction": "response", "generation": self.generation, "frame": safe(response)})
                if response.get("id") == request_id:
                    check("error" not in response, "Public RPC returned error: " + json.dumps(safe(response.get("error")), ensure_ascii=False))
                    return response["result"]
            check(time.monotonic() < deadline, "Runtime response timed out; outcome may be unknown, no automatic retry")
            readable, _, _ = select.select([self.process.stdout], [], [], min(1, max(0, deadline - time.monotonic())))
            if readable:
                chunk = os.read(self.process.stdout.fileno(), 65536)
                check(chunk, "Runtime stdout closed")
                self.pending += chunk
                check(len(self.pending) <= MAX_FRAME, "Runtime frame exceeds bound")

    def stop(self):
        if self.process is None:
            return
        process = self.process
        if process.poll() is None:
            try:
                self.rpc("agentkib.shutdown", {})
            except Exception:
                pass
            process.stdin.close()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
        self.log({"event": "runtime-stop", "generation": self.generation, "pid": process.pid, "exit_code": process.returncode})
        self.process, self.pending = None, b""


def validate_cursor_identity(app_root, name, version, package_hash, binary_hash, declared_hash):
    check(app_root in VERIFIED_APP_ROOTS, "Cursor context is not an exact verified vendor application")
    check(name == "Cursor" and version == "3.22.12", "Actual Cursor application name/version differs")
    check(package_hash == declared_hash == CURSOR_PACKAGE_SHA256, "Actual Cursor app package hash changed")
    check(binary_hash == CURSOR_BINARY_SHA256, "Actual Cursor main binary differs from the verified vendor binary")


def inspect_context(context):
    app_root = canonical(context["app_root"])
    check(str(app_root) == context["app_root"] and str(app_root) in VERIFIED_APP_ROOTS,
          "Cursor context is not an exact verified vendor application")
    bundle = app_root.parents[2]
    app_package = canonical(app_root / "package.json")
    binary = canonical(bundle / "Contents/MacOS/Cursor")
    package_bytes = app_package.read_bytes()
    package = json.loads(package_bytes)
    package_hash, binary_hash = sha(package_bytes), sha(binary.read_bytes())
    validate_cursor_identity(str(app_root), package["name"], package["version"], package_hash,
                             binary_hash, context["app_hash"])
    signature = subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(bundle)],
                               stdin=subprocess.DEVNULL, capture_output=True, timeout=15,
                               env={"PATH": "/usr/bin:/bin"}, check=False)
    check(signature.returncode == 0, "Vendor Cursor code signature verification failed")
    return {"app_root": str(app_root), "name": package["name"], "version": package["version"],
            "package_sha256": package_hash, "main_binary_sha256": binary_hash,
            "codesign_deep_strict": True}


def database_snapshot(manifest, case, plan, native_id=None):
    context = plan["cursor"]
    path = canonical(context["profile"]["db_path"])
    check(path == canonical(Path(manifest["cursor_userdata"]) / "User/globalStorage/state.vscdb"), "Plan database is outside isolated Cursor default profile")
    check(context["profile"]["version"] == "3.22.12" and context["profile"]["workspace"] == case["workspace"], "Cursor profile does not match case")
    check(context["extension_version"] == "0.1.0", "Unverified production extension version")
    app_identity = inspect_context(context)
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(path) + suffix)
        if sidecar.exists():
            check(sidecar.is_file() and not sidecar.is_symlink(), "Unsafe SQLite sidecar")
    uri = "file:" + urllib.parse.quote(str(path), safe="/") + "?mode=ro"
    with sqlite3.connect(uri, uri=True, timeout=0.1) as db:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN DEFERRED")
        check(db.execute("PRAGMA user_version").fetchone()[0] == 1, "Unverified Cursor SQLite version")
        expected = {"cursorDiskKV": ["key", "value"], "composerHeaders": ["composerId", "workspaceId", "createdAt", "lastUpdatedAt", "isArchived", "isSubagent", "recency", "checkpointAt", "subagentTypeName", "value"]}
        for table, columns in expected.items():
            check([row[1] for row in db.execute(f"PRAGMA table_info({table})")] == columns, "Unverified Cursor SQLite schema")
        header_count = db.execute("SELECT count(*) FROM composerHeaders").fetchone()[0]
        check(header_count <= 2000, "Header count exceeds acceptance bound")
        # Both real windows share a profile DB. Only this workspace's identities
        # belong to its import baseline; another case must not hide a duplicate.
        ids = [row[0] for row in db.execute("SELECT composerId FROM composerHeaders WHERE json_valid(value) AND json_extract(value,'$.workspaceIdentifier.uri.external')=? ORDER BY composerId", (Path(case["workspace"]).as_uri(),))]
        if native_id is None:
            return {"ids": ids, "db_path": str(path), "user_version": 1, "app_identity": app_identity}
        check(str(uuid.UUID(native_id)) == native_id, "Native target ID is not a canonical UUID")
        def record(table, column, key, limit):
            count, size = db.execute(f"SELECT count(*), max(length(value)) FROM {table} WHERE {column}=?", (key,)).fetchone()
            check(count == 1 and 0 <= size <= limit, "Native record missing, ambiguous, or oversized")
            value = db.execute(f"SELECT value FROM {table} WHERE {column}=?", (key,)).fetchone()[0]
            check(isinstance(value, (str, bytes)), "Unsupported SQLite record value type")
            return value.encode() if isinstance(value, str) else bytes(value)
        header_bytes = record("composerHeaders", "composerId", native_id, 262144)
        composer_bytes = record("cursorDiskKV", "key", "composerData:" + native_id, 16 * 1024 * 1024)
        header, composer = json.loads(header_bytes), json.loads(composer_bytes)
        indexed = db.execute("SELECT workspaceId,isArchived,isSubagent FROM composerHeaders WHERE composerId=?", (native_id,)).fetchone()
        for value in (header, composer):
            check(value["composerId"] == native_id and value.get("source", "local") == "local" and value.get("subagentInfo") is None, "Native identity/surface mismatch")
            workspace = value["workspaceIdentifier"]
            check(workspace["id"] == indexed[0] and workspace["uri"]["scheme"] == "file", "Native workspace identity mismatch")
            check(Path(urllib.parse.unquote(urllib.parse.urlparse(workspace["uri"]["external"]).path)) == Path(case["workspace"]), "Native workspace URL mismatch")
            check(workspace["uri"].get("fsPath", case["workspace"]) == case["workspace"], "Native workspace representations disagree")
        check(indexed[1:] == (0, 0) and not header.get("isArchived", False) and not header.get("isEphemeral", False), "Native archive/ephemeral mismatch")
        check(composer["_v"] == 18, "Native composer schema mismatch")
        payload = json.loads(plan["payload"])
        check(header["name"] in (payload["name"], "(1) " + payload["name"]), "Native import marker mismatch")
        marker_count = db.execute("SELECT count(*) FROM composerHeaders WHERE json_valid(value) AND json_extract(value,'$.name') IN (?,?)", (payload["name"], "(1) " + payload["name"])).fetchone()[0]
        check(marker_count == 1, "Import marker is missing or duplicated")
        root = base64.b64decode(composer["conversationState"][1:], validate=True)
        reviewed_root = base64.b64decode(payload["conversationState"], validate=True)
        vendor_root = vendor_import_root(reviewed_root)
        check(composer["conversationState"].startswith("~") and root == vendor_root, "Full native root differs from exact vendor encoding of reviewed payload")
        blobs = {}
        for key, encoded in payload["blobs"].items():
            raw = record("cursorDiskKV", "key", "agentKv:blob:" + key, 16 * 1024 * 1024)
            check(sha(raw) == key and raw == base64.b64decode(encoded, validate=True), "Full native blob differs from reviewed payload")
            blobs[key] = {"sha256": sha(raw), "bytes": len(raw)}
        return {"db_path": str(path), "native_id": native_id, "ids": ids, "marker_count": marker_count,
                "root_sha256": sha(root), "root_bytes": len(root), "blobs": blobs, "header_sha256": sha(header_bytes),
                "composer_sha256": sha(composer_bytes), "full_payload_exact": root == reviewed_root,
                "all_blobs_exact": True, "vendor_root_exact": True, "reviewed_root_sha256": sha(reviewed_root),
                "root_layout_normalized": root != reviewed_root, "sqlite_read_only": True,
                "app_identity": app_identity}


class Harness:
    def __init__(self, manifest):
        self.manifest = manifest
        self.evidence = Path(manifest["evidence"])
        self.state = json.loads((self.evidence / "state.json").read_text())
        self.sequence = max((int(path.stem.split("-")[1]) for path in self.evidence.glob("stage-*.json")), default=0)
        self.running = True
        self.runtime = Runtime(manifest, self.log)

    def log(self, record):
        with (self.evidence / "rpc.jsonl").open("a") as output:
            output.write(json.dumps({"time_ns": time.time_ns(), **safe(record)}, ensure_ascii=False) + "\n")
        (self.evidence / "rpc.jsonl").chmod(0o600)

    def save(self):
        private_json(self.evidence / "state.json", self.state)

    def check_sources(self):
        for case in self.state["cases"].values():
            check(sha(Path(case["source"]).read_bytes()) == case["source_sha256"], "Synthetic source changed")

    def bootstrap(self):
        self.runtime.start()
        for case in self.state["cases"].values():
            added = self.runtime.rpc("workspace.add", {"path": case["workspace"]})
            case["workspace_id"] = added["id"]
            sessions = self.runtime.rpc("workspace.refreshSessions", {"workspaceId": added["id"], "force": True})
            sources = [s for s in sessions if s["agent"] == "claude-code"]
            check(len(sources) == 1, "Fresh synthetic source must be unique")
            case["source_session_id"] = sources[0]["id"]
        self.save()
        return {"ready": True, "cases": {label: {k: case[k] for k in ("workspace", "workspace_id", "source_session_id", "marker")} for label, case in self.state["cases"].items()}}

    def readback(self, case):
        operations = self.runtime.rpc("sessions.nativeImports", {"workspaceId": case["workspace_id"]})
        check(len(operations) == 1, "Case must have exactly one native operation")
        operation = operations[0]
        check(operation["source_session_id"] == case["source_session_id"] and operation["binding_id"] == case["binding_id"], "Operation source/binding mismatch")
        launch = case["plan"]["launch_request"]
        actual_launch = operation["launch_request"]
        for key in ("operation_id", "workspace_id", "target_agent", "plan_hash"):
            check(actual_launch[key] == launch[key], "Durable native operation differs from approved launch request")
        target = canonical(case["plan"]["change_set"]["changes"][0]["target"])
        expected_target = canonical(Path(self.manifest["fixture"]) / "data/continuations" / sha(case["workspace_id"].encode())[:32] / case["native_plan"]["operation_id"] / "import/plan.json")
        check(target == expected_target, "Applied plan escaped isolated application data")
        plan_bytes = target.read_bytes()
        check(sha(plan_bytes) == launch["plan_hash"] and plan_bytes == case["plan"]["change_set"]["changes"][0]["after"].encode(), "Applied plan bytes/hash differ from reviewed Changes")
        check(json.loads(plan_bytes) == case["native_plan"], "Applied native plan differs")
        check(operation["status"] == "launched", "Native operation is not launched; preserve and reconcile explicitly")
        native_id = operation["target_session_id"]
        check(case.get("native_id", native_id) == native_id, "Native ID changed")
        snapshot = database_snapshot(self.manifest, case, case["native_plan"], native_id)
        baseline = case["before_native"]["ids"]
        check(set(snapshot["ids"]) - set(baseline) == {native_id}, "Import did not create exactly one native identity")
        sessions = self.runtime.rpc("workspace.refreshSessions", {"workspaceId": case["workspace_id"], "force": True})
        payload_name = json.loads(case["native_plan"]["payload"])["name"]
        cursors = [s for s in sessions if s["agent"] == "cursor" and s.get("title") in (payload_name, "(1) " + payload_name)]
        check(len(cursors) == 1, "Public native source must be unique")
        session_id = cursors[0]["id"]
        listed = self.runtime.rpc("workspace.sessions", {"workspaceId": case["workspace_id"]})
        check(sum(s["id"] == session_id for s in listed) == 1, "Public workspace session missing/duplicated")
        events = self.runtime.rpc("session.events", {"sessionId": session_id, "limit": 100})
        check(not events["warnings"] and events["next_cursor"] is None, "Public history is incomplete")
        expected = [("user-message" if turn["role"] == "user" else "agent-message", "\n\n".join(block["text"] for block in turn["blocks"])) for turn in case["native_plan"]["expected"]["turns"]]
        observed = [(event["kind"], event["content"]) for event in events["events"]]
        check(observed == expected and all(not e["truncated"] for e in events["events"]), "Public full native role/text differs from approved plan")
        check(observed[1:] == [("user-message" if role == "user" else "agent-message", content) for role, content in case["messages"]], "Source text did not survive exactly")
        capability = self.runtime.rpc("sessions.sourceCapability", {"sessionId": session_id})
        check(capability["source_surface"] == "cursor-ide" and capability["status"] == "supported", "Native Cursor source unavailable")
        if "snapshot" in case:
            stable = ("db_path", "native_id", "ids", "marker_count", "root_sha256", "root_bytes", "blobs", "full_payload_exact", "all_blobs_exact", "vendor_root_exact", "reviewed_root_sha256", "root_layout_normalized", "sqlite_read_only", "app_identity")
            check(all(snapshot[key] == case["snapshot"][key] for key in stable) and events == case["events"], "Native identity/root/blobs/full events changed after repetition/restart")
        case.update(native_id=native_id, native_source_session_id=session_id, snapshot=snapshot, events=events)
        return {"passed": True, "native_id": native_id, "source_session_id": session_id, "snapshot": snapshot, "events": events, "source_capability": capability}

    def command(self, command):
        allowed = {"action", "workspace", "binding_id"}
        check(isinstance(command, dict) and set(command) <= allowed, "Unknown command fields")
        action = command.get("action")
        check(action in ("status", "challenge", "clear-challenges", "preview", "plan", "changes", "import", "readback", "native-imports", "repeat", "reopen", "reopen-existing", "restart", "source-preview", "stop"), "Unsupported stage")
        self.check_sources()
        if action == "stop":
            self.running = False
            self.runtime.stop()
            return {"stopped": True}
        if action == "restart":
            self.runtime.stop()
            handshake = self.runtime.start()
            return {"restarted": True, "handshake": handshake, "requires_explicit_gui_reconnection_if_ambiguous": True}
        if action == "clear-challenges":
            count = 0
            for path in (Path(self.manifest["fixture"]) / "challenges").glob("challenge-*.json"):
                check(path.is_file() and not path.is_symlink(), "Unsafe challenge file")
                path.unlink()
                count += 1
            return {"deleted": count}
        label = command.get("workspace")
        check(label in self.state["cases"], "Select workspace a or b")
        case = self.state["cases"][label]
        binding = command.get("binding_id", case.get("binding_id"))
        if binding is not None:
            check(str(uuid.UUID(binding)) == binding, "Binding ID must be canonical UUID")
        workspace_id = case["workspace_id"]
        rpc = self.runtime.rpc
        if action in ("status", "challenge"):
            params = {"workspaceId": workspace_id, "action": "connect" if action == "challenge" else "status"}
            if binding:
                params["bindingId"] = binding
            result = rpc("cursor.bridge", params, challenge=action == "challenge")
            if action == "status":
                return result
            check(set(result) == {"challenge", "expires_in_seconds"}, "Unexpected challenge response")
            challenge = json.loads(result["challenge"])
            check(set(challenge) == {"socket", "ticket"} and len(challenge["ticket"]) == 64, "Unexpected challenge contract")
            path = Path(self.manifest["fixture"]) / "challenges" / ("challenge-" + uuid.uuid4().hex + ".json")
            # The exact input string is local only; root supplies it to the real GUI.
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as output:
                output.write(result["challenge"])
            expiry = threading.Timer(result["expires_in_seconds"], lambda: path.unlink(missing_ok=True))
            expiry.daemon = True
            expiry.start()
            return {"challenge_file": str(path), "expires_in_seconds": result["expires_in_seconds"], "challenge_redacted": True}
        if action == "native-imports":
            return rpc("sessions.nativeImports", {"workspaceId": workspace_id})
        if action == "preview":
            check("plan" not in case and label not in self.state["attempts"], "Do not replace a prepared or attempted operation")
            check(binding is not None, "Select an exact connected binding for preview")
            status = rpc("cursor.bridge", {"action": "status", "workspaceId": workspace_id})
            check(any(item["id"] == binding and item["connected"] for item in status["bindings"]), "Selected binding is not connected")
            result = rpc("sessions.prepareHandoff", {"request": {"session_id": case["source_session_id"], "target_agent": "cursor", "target_surface": "cursor-ide", "binding_id": binding, "format": "markdown", "history_budget_tokens": 64000}})
            check(result["draft"]["mode"] == "native-session", "Native Cursor preview unavailable")
            case.update(binding_id=binding, preview=result)
            return result
        if action == "plan":
            check("preview" in case and "plan" not in case and label not in self.state["attempts"], "Preview required; each case has one plan")
            draft = case["preview"]["draft"]
            result = rpc("sessions.planHandoff", {"sessionId": case["source_session_id"], "workspaceId": workspace_id, "filename": draft["filename"], "format": "markdown", "targetAgent": "cursor", "targetSurface": "cursor-ide", "bindingId": case["binding_id"], "mode": draft["mode"], "sourceFingerprint": draft["source_fingerprint"], "targetFingerprint": draft.get("target_fingerprint"), "acceptLosses": True, "historyBudgetTokens": 64000, "archiveId": draft.get("archive_id")})
            check(len(result["change_set"]["changes"]) == 1, "Cursor plan must have exactly one application-data change")
            native_plan = json.loads(result["change_set"]["changes"][0]["after"])
            check(native_plan["target_agent"] == "cursor" and native_plan["cursor"]["binding_id"] == case["binding_id"], "Plan target/binding mismatch")
            case.update(plan=result, native_plan=native_plan)
            self.save()  # A validation failure cannot silently create another plan.
            case["before_native"] = database_snapshot(self.manifest, case, native_plan)
            return result
        if action == "changes":
            check("plan" in case, "Plan required")
            case["changes_reviewed"] = True
            return {"change_set": case["plan"]["change_set"], "launch_request": case["plan"]["launch_request"], "applied": label in self.state["attempts"]}
        if action in ("import", "repeat"):
            check("plan" in case, "Plan required")
            if action == "import":
                check(case.get("changes_reviewed") and "before_native" in case, "Review Changes and pass the native baseline before import")
                check(label not in self.state["attempts"], "Initial import already attempted; only original operation reconciliation is allowed")
                self.state["attempts"][label] = {"time_ns": time.time_ns(), "operation_id": case["native_plan"]["operation_id"]}
                self.save()  # Persist before any production dispatch; never automatically retry an unknown outcome.
            else:
                check(label in self.state["attempts"], "Initial import required before repetition")
            result = rpc("sessions.continueHandoff", {"changeSet": case["plan"]["change_set"], "launchRequest": case["plan"]["launch_request"], "approveHome": True})
            check(result["status"] == "launched", "Native outcome is not launched; no new plan/import permitted")
            case.setdefault("continuations", []).append(result)
            return {"continuation": result, "readback": self.readback(case)}
        if action == "readback":
            check("plan" in case, "Plan required")
            return self.readback(case)
        if action in ("reopen", "reopen-existing"):
            check(label in self.state["attempts"] and "native_id" in case, "Verified original import required for reopening")
            result = rpc("sessions.launchHandoff", case["plan"]["launch_request"])
            check(result == {"target_agent": "cursor", "terminal": "Cursor IDE"}, "Original native ID did not reopen successfully")
            if action == "reopen-existing":
                # A real reply appends history. Preserve the original exact
                # readback contract; independent post-reply graph/content and
                # actual GUI observations must verify this later phase.
                return {"launch": result, "expected_native_id": case["native_id"],
                        "full_readback_performed": False,
                        "independent_graph_and_gui_verification_required": True,
                        "no_import_or_model_dispatch": True}
            return {"launch": result, "readback": self.readback(case), "gui_selection_requires_root_observation": True}
        if action == "source-preview":
            check("native_source_session_id" in case, "Full native readback required")
            results = {}
            for target in ("claude-code", "codex", "opencode", "hermes", "open-claw"):
                result = rpc("sessions.prepareHandoff", {"request": {"session_id": case["native_source_session_id"], "target_agent": target, "format": "markdown", "history_budget_tokens": 64000}})
                content = result["draft"]["content"]
                check(all(text in content for _, text in case["messages"]), "Outgoing public preview omitted native history")
                results[target] = result
            return {"passed": True, "previews": results, "no_launch_or_model_call": True}
        raise RuntimeError("Unreachable stage")

    def execute(self, command):
        self.sequence += 1
        # Never use caller text in paths.
        response_file = self.evidence / f"stage-{self.sequence:03d}.json"
        try:
            response = {"ok": True, "command": command, "result": self.command(command)}
        except Exception as error:
            response = {"ok": False, "command": safe(command), "error": str(error), "no_automatic_retry": True}
        self.save()
        self.check_sources()
        private_json(response_file, safe(response), True)
        self.log({"event": "stage", "response_file": str(response_file), "result": safe(response)})
        return {**safe(response), "response_file": str(response_file)}


def serve(args):
    manifest_path = canonical(args.evidence) / "manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if args.runtime_update is not None:
        # Explicit QA upgrade for recovery: preserve the original manifest,
        # frozen binary, approved payload and attempts; never prepare a new op.
        runtime = canonical(args.runtime_update)
        check(runtime.is_file(), "Updated Runtime is missing")
        digest = sha(runtime.read_bytes())
        receipt = Path(manifest["evidence"]) / ("runtime-update-" + digest + ".json")
        frozen = Path(manifest["evidence"]) / "tools" / ("agentkib-runtime-" + digest)
        check(not Path(manifest["control_socket"]).exists(), "A harness is still running; do not update it")
        check(sha(canonical(manifest["runtime"]).read_bytes()) == manifest["runtime_sha256"], "Original frozen Runtime changed")
        identity = {"original_manifest_sha256": sha(manifest_bytes),
                    "original_runtime_sha256": manifest["runtime_sha256"],
                    "updated_runtime_sha256": digest, "updated_runtime": str(frozen),
                    "frozen_plans_and_attempts_preserved": True}
        if receipt.exists() or frozen.exists():
            check(receipt.is_file() and not receipt.is_symlink() and receipt.stat().st_size <= 16384
                  and frozen.is_file() and not frozen.is_symlink(), "Incomplete or unsafe frozen Runtime update")
            saved = json.loads(receipt.read_text())
            check(set(saved) == set(identity) | {"harness_sha256"} and
                  all(saved[key] == value for key, value in identity.items()) and
                  isinstance(saved["harness_sha256"], str) and len(saved["harness_sha256"]) == 64 and
                  all(char in "0123456789abcdef" for char in saved["harness_sha256"]),
                  "Frozen Runtime update receipt identity changed")
        else:
            with frozen.open("xb") as output:
                output.write(runtime.read_bytes())
            frozen.chmod(0o700)
            private_json(receipt, {**identity, "harness_sha256": sha(Path(__file__).read_bytes())}, True)
        check(sha(frozen.read_bytes()) == digest == sha(runtime.read_bytes()), "Runtime changed during update freeze or recovery")
        manifest = {**manifest, "runtime": str(frozen), "runtime_original": str(runtime), "runtime_sha256": digest}
    harness = Harness(manifest)
    path = Path(manifest["control_socket"])
    check(not path.exists(), "Control socket exists; do not replace a running harness")
    server = socket.socket(socket.AF_UNIX)
    server.bind(str(path))
    path.chmod(0o600)
    server.listen(4)
    try:
        ready = harness.bootstrap()
        ready_path = Path(manifest["evidence"]) / ("ready.json" if not (Path(manifest["evidence"]) / "ready.json").exists() else f"ready-{harness.runtime.generation:03d}.json")
        private_json(ready_path, ready, True)
        print(json.dumps({**ready, "control_socket": str(path)}, ensure_ascii=False), flush=True)
        while harness.running:
            readers = [server] + ([sys.stdin] if args.stdin else [])
            available, _, _ = select.select(readers, [], [], 1)
            for reader in available:
                if reader is sys.stdin:
                    line = sys.stdin.readline(MAX_FRAME)
                    if not line:
                        harness.running = False
                        break
                    print(json.dumps(harness.execute(json.loads(line)), ensure_ascii=False), flush=True)
                else:
                    connection, _ = server.accept()
                    with connection:
                        connection.settimeout(10)
                        raw = b""
                        while b"\n" not in raw:
                            chunk = connection.recv(65536)
                            check(chunk and len(raw) + len(chunk) <= 65536, "Invalid control frame")
                            raw += chunk
                        check(raw.endswith(b"\n") and raw.count(b"\n") == 1, "One control command per connection")
                        response = harness.execute(json.loads(raw))
                        connection.sendall((json.dumps(response, ensure_ascii=False) + "\n").encode())
    finally:
        harness.runtime.stop()
        server.close()
        path.unlink(missing_ok=True)
        for challenge in (Path(manifest["fixture"]) / "challenges").glob("challenge-*.json"):
            if challenge.is_file() and not challenge.is_symlink():
                challenge.unlink()


def send(args):
    manifest = json.loads((canonical(args.evidence) / "manifest.json").read_text())
    command = json.loads(Path(args.file).read_text() if args.file else args.json)
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(210)
        client.connect(manifest["control_socket"])
        client.sendall((json.dumps(command, ensure_ascii=False) + "\n").encode())
        chunks, total = [], 0
        while True:
            chunk = client.recv(65536)
            if not chunk:
                break
            total += len(chunk)
            check(total <= MAX_FRAME, "Control response exceeds bound")
            chunks.append(chunk)
        print(b"".join(chunks).decode(), end="")


def selftest():
    def field(number, value):
        check(len(value) < 128, "Selftest value bound")
        return bytes([(number << 3) | 2, len(value)]) + value
    uri = field(9, b"file:///synthetic-workspace")
    prompt1, prompt2, turn = field(1, b"a" * 32), field(1, b"b" * 32), field(8, b"c" * 32)
    check(vendor_import_root(prompt1 + turn + prompt2 + uri) == prompt1 + prompt2 + turn + uri,
          "Vendor encoding changed same-field order")
    check(vendor_import_root(prompt2 + turn + prompt1 + uri) == prompt2 + prompt1 + turn + uri,
          "Vendor encoding sorted references")
    bad_roots = [prompt1 + turn, prompt1 + turn + uri + uri, prompt1 + turn + uri + field(10, b"unknown"),
                 field(1, b"a" * 31) + turn + uri, prompt1 + turn + uri[:-1],
                 b"\x08\x01" + turn + uri, b"\x8a\x00\x20" + b"a" * 32 + turn + uri,
                 b"\x0a\xa0\x00" + b"a" * 32 + turn + uri, prompt1 + turn + field(9, b"https://wrong"),
                 prompt1 + turn + field(9, b"\xff")]
    for root in bad_roots:
        try:
            vendor_import_root(root)
        except (RuntimeError, UnicodeError):
            pass
        else:
            raise RuntimeError("Unsupported reviewed root shape was accepted")
    for fixture in ("harness", "harness-contextfix-1001"):
        validate_fixture_name(fixture)
    for fixture in ("", "/tmp/harness", "harness/../old", "harness\\old", "harness-中文", "harness" + "a" * 64):
        try:
            validate_fixture_name(fixture)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("Unsafe fixture name was accepted")
    check(safe({"challenge": '{"ticket":"never-log"}', "nested": [{"credential_hash": "never-log", "id": "safe"}]}) ==
          {"challenge": "[redacted]", "nested": [{"credential_hash": "[redacted]", "id": "safe"}]}, "Redaction failed")
    check("never-log" not in json.dumps(safe({"Ticket": "never-log", "API-Key": "never-log", "token": "never-log"})), "Secret aliases escaped redaction")
    identity = [VERIFIED_APP_ROOTS[0], "Cursor", "3.22.12", CURSOR_PACKAGE_SHA256, CURSOR_BINARY_SHA256, CURSOR_PACKAGE_SHA256]
    negatives = [(0, "/tmp/Cursor.app/Contents/Resources/app"), (0, VERIFIED_APP_ROOTS[1] + "/../app"),
                 (1, "Code"), (2, "3.22.13"), (3, "0" * 64), (4, "0" * 64), (5, "0" * 64)]
    for field, invalid in negatives:
        candidate = identity.copy()
        candidate[field] = invalid
        try:
            validate_cursor_identity(*candidate)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("Unverified vendor identity was accepted")
    proofs = [inspect_context({"app_root": root, "app_hash": CURSOR_PACKAGE_SHA256}) for root in VERIFIED_APP_ROOTS]
    print(json.dumps({"passed": True, "checks": ["vendor root grouping preserves same-field order; 10 rejected root shapes", "2 fixture name positives and 6 negative cases", "recursive challenge/credential/ticket redaction", "case preserving secret aliases", "7 vendor identity negative cases"],
                      "actual_signed_vendor_apps": proofs, "model_calls": 0, "cursor_db_writes": 0}))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--evidence", type=Path, default=EVIDENCE)
    commands = parser.add_subparsers(dest="mode", required=True)
    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("--runtime", type=Path, required=True)
    prepare_parser.add_argument("--fixture-name", default="harness")
    serve_parser = commands.add_parser("serve")
    serve_parser.add_argument("--stdin", action="store_true")
    serve_parser.add_argument("--runtime-update", type=Path)
    send_parser = commands.add_parser("send")
    source = send_parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--json")
    source.add_argument("--file", type=Path)
    commands.add_parser("selftest")
    args = parser.parse_args()
    {"prepare": prepare, "serve": serve, "send": send, "selftest": lambda _: selftest()}[args.mode](args)


if __name__ == "__main__":
    main()
