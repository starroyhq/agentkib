"""One Claude native CLI turn behind an in-memory, one-forward loopback guard.

  python3 claude-native-once.py mock NEW_DIRECTORY HTTP_STATUS
  python3 claude-native-once.py live EXISTING_PUBLIC_CLAUDE_CASE

Mock mode never forwards, uses a synthetic credential and separate HOME/config.
Live mode requires a verified retry-window proof and a complete synthetic import.
Never retries CLI, changes model, writes credentials, or logs auth headers.
"""
import datetime
import hashlib
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import sqlite3
import socket
import yaml
import subprocess
import sys
import threading
import time
import uuid
import importlib.util
from claude_import_validation import verify as verify_public_import
from qa_owned_cli import run_owned_cli

CLAUDE = Path('/Users/user/.local/share/claude/versions/2.1.285')
SETTINGS = Path('/Users/user/.claude/settings.json')
CLI_FLAGS = ['--safe-mode', '--setting-sources', '', '--strict-mcp-config', '--tools', '',
             '--permission-mode', 'dontAsk', '--max-turns', '1', '--max-budget-usd', '0.50',
             '--print', '--output-format', 'json']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def private_json(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump(data, file, indent=2)
        file.flush()
        os.fsync(file.fileno())
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _check_window():
    raw = os.environ.get('AGENTKIB_RETRY_WINDOW')
    if not raw:
        raise RuntimeError('No retry-window authorization proof')
    path = Path(raw)
    if not path.is_file() or path.is_symlink() or path.stat().st_mode & 0o077 or path.parent.stat().st_mode & 0o077:
        raise RuntimeError('Unsafe retry-window proof file')
    proof = json.loads(path.read_text())
    if proof.get('schemaVersion') != 1 or proof.get('status') != 'open':
        raise RuntimeError('Retry window is not open')
    expiry = datetime.datetime.fromisoformat(proof['expiresAt'])
    if (expiry - datetime.datetime.now(datetime.timezone.utc)).total_seconds() < 180:
        raise RuntimeError('Retry window expires too soon')
    if proof.get('endpoint') != 'http://127.0.0.1:8317':
        raise RuntimeError('Retry window endpoint mismatch')
    if proof.get('model') != 'relay/claude-opus-5-5' or proof.get('retryPolicy') != {
        'requestRetry': 0, 'maxRetryCredentials': 1, 'streamBootstrapRetries': 0,
        'credentialOverrides': False, 'ccSwitchRectifierEnabled': False,
        'ccSwitchAutoFailoverEnabled': False, 'quotaSwitchProject': False, 'quotaSwitchPreviewModel': False}:
        raise RuntimeError('Retry window policy mismatch')
    config = yaml.safe_load(Path('/Users/user/proxy/CLIProxyAPI/config.yaml').read_text())
    if config['routing']['retry']['request-retry'] != 0 or config['routing']['retry']['max-retry-credentials'] != 1 or config['requests']['streaming']['bootstrap-retries'] != 0:
        raise RuntimeError('CPA actual retry fields changed')
    with sqlite3.connect('file:/Users/user/.cc-switch/cc-switch.db?mode=ro', uri=True) as db:
        rectifier = db.execute("select value from settings where key='rectifier_config'").fetchone()
        failover = db.execute("select auto_failover_enabled from proxy_config where app_type='claude'").fetchone()
        provider = db.execute("select settings_config from providers where app_type='claude' and is_current=1").fetchall()
    if not rectifier or json.loads(rectifier[0]).get('enabled') is not False or not failover or failover[0] != 0:
        raise RuntimeError('CC Switch retry fields changed')
    if len(provider) != 1:
        raise RuntimeError('CC Switch provider selection changed')
    provider_env = json.loads(provider[0][0]).get('env', {})
    if provider_env.get('ANTHROPIC_BASE_URL') not in ('http://localhost:8317', 'http://127.0.0.1:8317') or provider_env.get('ANTHROPIC_DEFAULT_OPUS_MODEL') != 'relay/claude-opus-5-5':
        raise RuntimeError('CC Switch provider or model mapping changed')
    return proof


def check_window():
    try:
        proof = _check_window()
        spec = importlib.util.spec_from_file_location('retry_window_checks', Path(__file__).with_name('temporary-retry-window.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.check_overrides()
        return proof
    except Exception:
        raise RuntimeError('Retry-window preflight rejected; no model dispatched') from None


def validate_request(body, expected_model, expected_history, prompt):
    parsed = json.loads(body)
    if parsed.get('model') != expected_model or parsed.get('tools'):
        raise RuntimeError('Unexpected model or tools in native request')
    messages = parsed.get('messages', [])
    flattened = []
    for message in messages:
        content = message.get('content', [])
        if isinstance(content, str):
            content = [{'type': 'text', 'text': content}]
        for block in content:
            if block.get('type') != 'text':
                raise RuntimeError('Unexpected native input block')
            flattened.append((message.get('role'), block.get('text', '')))
    flattened = [item for item in flattened if item[0] != 'system']
    if len(flattened) != len(expected_history) + 1:
        raise RuntimeError('Unexpected extra model-visible conversation text')
    cursor = 0
    for source_index, (role, text) in enumerate(expected_history + [('user', prompt)]):
        allowed_texts = {text}
        # Fixed CLI 2.1.285 appends exactly one newline to the imported notice
        # when it merges consecutive user messages. Synthetic native capture
        # proves this delimiter; no other source text is trimmed or normalized.
        if source_index == 0 and len(expected_history) > 1 and role == expected_history[1][0] == 'user':
            allowed_texts.add(text + '\n')
        matches = [index for index, item in enumerate(flattened) if item[0] == role and item[1] in allowed_texts]
        # CLI may merge adjacent text fragments into a single message, but must
        # retain each full source string exactly once with the same role/order.
        if len(matches) != 1 or matches[0] < cursor:
            raise RuntimeError('Native model request does not preserve complete history and prompt')
        cursor = matches[0] + 1
    return parsed['model']


def forward_once(path, body, headers, stopping, gate, sockets, state):
    connection = HTTPConnection('127.0.0.1', 15721, timeout=1)
    owned_socket = None
    try:
        connection.connect()
        owned_socket = connection.sock
        with gate:
            if stopping.is_set():
                raise RuntimeError('Guard stopped during connect')
            owned_socket.settimeout(150)
            sockets.add(owned_socket)
        check_window()
        with gate:
            if stopping.is_set():
                raise RuntimeError('Guard stopped before dispatch')
            state['upstreamDispatches'] += 1
        connection.request('POST', path, body=body, headers=headers)
        upstream = connection.getresponse()
        code = upstream.status
        content_type = upstream.getheader('Content-Type', 'application/json')
        response = upstream.read(16 * 1024 * 1024 + 1)
        if len(response) > 16 * 1024 * 1024:
            raise RuntimeError('Response exceeds guard limit')
        return code, content_type, response
    finally:
        if owned_socket is not None:
            with gate:
                sockets.discard(owned_socket)
            owned_socket.close()
        connection.close()


def stop_transport(stopping, gate, sockets):
    stopping.set()
    with gate:
        for owned_socket in sockets:
            try:
                owned_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            owned_socket.close()


def main(mode, case, status=None, resume_fixture=None):
    live = mode == 'live'
    if live:
        check_window()
        verify_public_import(case)
        imported = json.loads((case / 'result.json').read_text())
        if imported.get('target') != 'claude-code' or not imported.get('sourceUnchanged') or not imported.get('exactPayloadMatched'):
            raise RuntimeError('Public import was not verified')
        session = imported['targetSessionId']
        target = Path(imported['targetPath']).resolve()
        if not target.is_relative_to(case / 'claude'):
            raise RuntimeError('Target escapes isolated config')
        original = target.read_bytes()
        rows = [json.loads(line) for line in original.splitlines()]
        expected_history = [(row['message']['role'], block['text']) for row in rows if row['type'] in ('user', 'assistant') for block in row['message']['content']]
        if any(Path(row['cwd']).resolve() != (case / 'workspace').resolve() for row in rows if 'cwd' in row):
            raise RuntimeError('Imported workspace differs')
        for name, expected in imported['sourceFiles'].items():
            if sha(Path(name)) != expected:
                raise RuntimeError('Synthetic source changed')
        settings_path = SETTINGS
        settings_hash = sha(SETTINGS)
        # Permit exactly the already inspected CC Switch path and current opus
        # selection. Values are checked in memory; no settings copy is created.
        data = json.loads(SETTINGS.read_text())
        if data.get('model') != 'opus' or data.get('env', {}).get('ANTHROPIC_BASE_URL') != 'http://127.0.0.1:15721' or data.get('env', {}).get('ANTHROPIC_DEFAULT_OPUS_MODEL') != 'claude-opus-5':
            raise RuntimeError('Original model or proxy changed')
        prompt = 'What exact random marker and project storage decision did we agree in the imported history? Quote both, without using any tools.'
    else:
        case.mkdir(mode=0o700, parents=False, exist_ok=False)
        for name in ('home', 'claude', 'workspace'):
            (case / name).mkdir(mode=0o700)
        settings_path = case / 'synthetic-settings.json'
        private_json(settings_path, {'model': 'opus', 'env': {'ANTHROPIC_AUTH_TOKEN': 'synthetic-not-a-credential', 'ANTHROPIC_BASE_URL': 'http://127.0.0.1:9', 'ANTHROPIC_DEFAULT_OPUS_MODEL': 'claude-opus-5'}})
        settings_hash = sha(settings_path)
        data = json.loads(settings_path.read_text())
        session = None
        expected_history = []
        prompt = 'Reply once with only SYNTHETIC.'
    if not live and resume_fixture is not None:
        verify_public_import(resume_fixture)
        fixture = json.loads((resume_fixture / 'result.json').read_text())
        records = [json.loads(line) for line in Path(fixture['targetPath']).read_text().splitlines()]
        session = str(uuid.uuid4())
        for record in records:
            record['sessionId'] = session
            if 'cwd' in record:
                record['cwd'] = str(case / 'workspace')
        project = str(case / 'workspace').replace('/', '-')
        mock_target = case / 'claude/projects' / project / (session + '.jsonl')
        mock_target.parent.mkdir(parents=True)
        mock_target.write_text('\n'.join(json.dumps(record) for record in records) + '\n')
        expected_history = [(row['message']['role'], block['text']) for row in records if row['type'] in ('user', 'assistant') for block in row['message']['content']]
    # Durable exclusive marker forbids starting this case again, even after a
    # lost response or process crash. A new case is a distinct explicit request.
    private_json(case / 'claude-once-started.json', {'version': 1, 'mode': mode,
        'sessionId': session, 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()})
    state = {'version': 1, 'mode': mode, 'probeSha256': sha(Path(__file__)), 'cliSha256': sha(CLAUDE), 'requests': [],
             'cliVersion': '2.1.285', 'forwardAttempts': 0, 'upstreamDispatches': 0, 'blockedDuplicates': 0, 'upstream': 'http://127.0.0.1:15721' if live else None}
    gate = threading.Lock()
    sockets = set()
    stopping = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get('Content-Length', '0'))
            if length < 0 or length > 32 * 1024 * 1024:
                self.send_error(413)
                return
            body = self.rfile.read(length)
            path = self.path.split('?', 1)[0]
            with gate:
                state['requests'].append({'method': 'POST', 'path': path})
                accepted = path == '/v1/messages' and state['forwardAttempts'] == 0 and not stopping.is_set()
                if accepted:
                    state['forwardAttempts'] += 1
                elif path == '/v1/messages':
                    state['blockedDuplicates'] += 1
            if accepted:
                if not live:
                    private_json(case / 'synthetic-request.json', json.loads(body))
                try:
                    model = validate_request(body, data['env']['ANTHROPIC_DEFAULT_OPUS_MODEL'], expected_history, prompt)
                    state['validatedRequestModel'] = model
                except Exception:
                    state['requestRejected'] = 'Body model/history/prompt/tools mismatch'
                    accepted = False
            if not accepted:
                response = json.dumps({'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'One-shot guard rejected additional or unsupported request'}}).encode()
                code, content_type = 400, 'application/json'
            elif live:
                try:
                    headers = {key: value for key, value in self.headers.items()
                               if key.lower() not in ('host', 'connection', 'content-length', 'accept-encoding')}
                    headers['Content-Length'] = str(len(body))
                    code, content_type, response = forward_once(self.path, body, headers, stopping, gate, sockets, state)
                except Exception:
                    code, content_type = 502, 'application/json'
                    response = b'{"type":"error","error":{"type":"api_error","message":"One-shot dispatch failed or was rejected; outcome requires verification; retry forbidden"}}'
            elif status == 0:
                self.close_connection = True
                return  # Simulate a connection dropped after accepting the body.
            elif status == 200:
                code, content_type = 200, 'text/event-stream'
                response = b'event: message_start\ndata: {"type":"message_start","message":{"id":"synthetic","type":"message","role":"assistant","model":"synthetic","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'
            else:
                code, content_type = status, 'application/json'
                response = json.dumps({'type': 'error', 'error': {'type': 'rate_limit_error' if status == 429 else 'api_error',
                    'message': 'Invalid signature in thinking block' if status == 400 else 'Synthetic one-shot failure; no upstream was contacted'}}).encode()
            self.send_response(code)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(response)))
            self.send_header('Connection', 'close')
            self.end_headers()
            try:
                self.wfile.write(response)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    env = {'HOME': str(case / 'home'), 'CLAUDE_CONFIG_DIR': str(case / 'claude'),
           'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8', 'TERM': 'dumb',
           'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{server.server_port}',
           'CLAUDE_CODE_MAX_RETRIES': '0', 'CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES': '0',
           'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_AUTOUPDATER': '1'}
    inherited_provider = {key: value for key, value in data.get('env', {}).items()
                          if key.startswith('ANTHROPIC_') and isinstance(value, str)}
    inherited_provider.pop('ANTHROPIC_BASE_URL', None)
    env.update(inherited_provider)
    # All network except this one loopback listener is denied for the CLI. The
    # Python guard alone has permission to forward the one accepted live request.
    profile = f'(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:{server.server_port}"))'
    command = ['/usr/bin/sandbox-exec', '-p', profile, str(CLAUDE), '--settings', json.dumps({'model': data.get('model', 'opus')})] + CLI_FLAGS
    if session:
        command += ['--resume', session]
    command += [prompt]
    readers, writers, buffers, drainers = [], [], [], []
    for _ in range(2):
        read_fd, write_fd = os.pipe()
        readers.append(read_fd)
        writers.append(write_fd)
        buffer = bytearray()
        buffers.append(buffer)
        def drain(fd=read_fd, output=buffer):
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                if len(output) + len(chunk) > 32 * 1024 * 1024:
                    stopping.set()
                    break
                output.extend(chunk)
        thread = threading.Thread(target=drain, daemon=True)
        thread.start()
        drainers.append(thread)
    control = case / 'claude-once-control.json'
    private_json(control, {})
    try:
        run_owned_cli(command[:-1], env=env, cwd=case / 'workspace', config=control,
            original=control.read_bytes(), modified=control.read_bytes(), prompt=prompt,
            stdout=writers[0], stderr=writers[1], result=state,
            should_stop=lambda: stopping.is_set() or state['blockedDuplicates'] > 0, timeout=180)
        state['exitCode'] = state['cliExitCode']
        for descriptor in writers:
            os.close(descriptor)
        writers.clear()
        for thread in drainers:
            thread.join(timeout=5)
        stdout, stderr = (bytes(buffer) for buffer in buffers)
        # Only persist output after known authentication values are removed. The
        # CLI receives provider credentials in its short-lived environment only.
        for key, value in inherited_provider.items():
            if ('TOKEN' in key or 'KEY' in key) and value:
                stdout = stdout.replace(value.encode(), b'[REDACTED]')
                stderr = stderr.replace(value.encode(), b'[REDACTED]')
        for name, raw in (('claude-once.stdout', stdout), ('claude-once.stderr', stderr)):
            fd = os.open(case / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as file:
                file.write(raw)
        if live:
            response = json.loads((case / 'claude-once.stdout').read_text())
            state['nativeSessionId'] = response.get('session_id')
            state['modelUsage'] = response.get('modelUsage')
            state['usage'] = response.get('usage')
            state['totalCostUsd'] = response.get('total_cost_usd')
            state['numTurns'] = response.get('num_turns')
            answer = response.get('result', '')
            state['answer'] = answer
            state['nativeSuccess'] = response.get('is_error') is False
            state['markerMatched'] = imported['marker'] in answer
            state['decisionMatched'] = imported['decision'] in answer
    finally:
        previous_signals = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
        try:
            stop_transport(stopping, gate, sockets)
            for descriptor in writers:
                os.close(descriptor)
            for thread in drainers:
                thread.join(timeout=5)
            for descriptor in readers:
                os.close(descriptor)
            server.shutdown()
            server.server_close()
            state['settingsUnchanged'] = sha(settings_path) == settings_hash
            if live:
                state['sourceUnchanged'] = all(sha(Path(name)) == expected for name, expected in imported['sourceFiles'].items())
                state['originalHistoryPrefixPreserved'] = target.read_bytes().startswith(original)
                state['sessionFileCount'] = len(list((case / 'claude/projects').rglob('*.jsonl')))
            state['acceptancePassed'] = (all((state.get('exitCode') == 0, state['forwardAttempts'] == 1,
                state['blockedDuplicates'] == 0, state['upstreamDispatches'] == 1, state['settingsUnchanged'], state.get('nativeSuccess'),
                state.get('markerMatched'), state.get('decisionMatched'), state.get('nativeSessionId') == session,
                state.get('sourceUnchanged'), state.get('originalHistoryPrefixPreserved'),
                state.get('sessionFileCount') == 1, state.get('numTurns') == 1)) if live else
                state.get('exitCode') != 0 and state['forwardAttempts'] == 1 and 'requestRejected' not in state and bool(state.get('validatedRequestModel')))
            private_json(case / 'claude-once-result.json', state)
        finally:
            for sig, handler in previous_signals.items():
                signal.signal(sig, handler)
    print(json.dumps({key: state.get(key) for key in ('mode', 'exitCode', 'forwardAttempts', 'blockedDuplicates', 'settingsUnchanged')}))
    if not state['acceptancePassed']:
        raise RuntimeError('One-shot acceptance failed; do not retry this case')


if __name__ == '__main__':
    if len(sys.argv) in (4, 5) and sys.argv[1] == 'mock':
        main('mock', Path(sys.argv[2]).resolve(), int(sys.argv[3]), Path(sys.argv[4]).resolve() if len(sys.argv) == 5 else None)
    elif len(sys.argv) == 3 and sys.argv[1] == 'live':
        main('live', Path(sys.argv[2]).resolve())
    else:
        raise SystemExit(__doc__)
