"""QA-only direct DeepSeek one-dispatch relay; never changes provider settings.

load_current_provider() reads only the current Claude provider row in memory.
start_relay(contract_path, snapshot, *, offline=False, validator=None) exposes
base_url/client_token/sandbox_profile, redact(), summary(), stop_event and close().
Native clients receive only a random loopback token. Real credentials never leave
the relay except as the fixed HTTPS upstream Authorization header.
"""
import dataclasses
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import secrets
import socket
import sqlite3
import ssl
import threading
import time
from urllib.parse import urlsplit

MODEL = 'deepseek-v4-pro'
ENDPOINT = 'https://api.deepseek.com/anthropic'
DATABASE = Path('/Users/user/.cc-switch/cc-switch.db')
ROUTES = {'anthropic': ('/anthropic', '/v1/messages', '/anthropic/v1/messages'),
          'chat': ('/v1', '/chat/completions', '/chat/completions'),
          'responses': ('/v1', '/responses', '/responses')}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def private_json(path, value):
    path = Path(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(value, out, ensure_ascii=False, indent=2)
        out.flush()
        os.fsync(out.fileno())
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


@dataclasses.dataclass(frozen=True, repr=False)
class ProviderSnapshot:
    fingerprint: str
    _credential: str
    _database: Path | None
    def __repr__(self):
        return 'ProviderSnapshot(<private>)'
    def safe_metadata(self):
        return {'name': 'DeepSeek', 'endpoint': ENDPOINT, 'model': MODEL,
                'providerFingerprint': self.fingerprint, 'credentialPersisted': False}


def load_current_provider(database=DATABASE):
    """Never include SQL rows or parse exceptions in errors or logs."""
    try:
        with sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True) as db:
            cursor = db.execute("SELECT * FROM providers WHERE app_type='claude' AND is_current=1")
            columns = [column[0] for column in cursor.description]
            rows = [dict(zip(columns, row)) for row in cursor.fetchall()]
        assert len(rows) == 1
        row = rows[0]
        assert row['name'].lower() == 'deepseek' and row['is_current'] == 1
        env = json.loads(row['settings_config'])['env']
        assert env['ANTHROPIC_BASE_URL'] == ENDPOINT
        assert all(env.get(k) == MODEL for k in ('ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL'))
        values = {env[k] for k in ('ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY') if env.get(k)}
        assert len(values) == 1
        credential, = values
        assert isinstance(credential, str) and credential.strip() == credential and '\r' not in credential and '\n' not in credential
        fingerprint = digest(json.dumps(row, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode())
        return ProviderSnapshot(fingerprint, credential, Path(database).resolve())
    except Exception:
        raise RuntimeError('Current DeepSeek provider preflight rejected') from None


def synthetic_provider():
    return ProviderSnapshot('synthetic-provider-fingerprint', 'synthetic-upstream-key-not-real', None)


def content_parts(value, protocol):
    if isinstance(value, str):
        return [value]
    assert isinstance(value, list) and value
    parts = []
    for item in value:
        assert isinstance(item, dict)
        assert item.get('type') in ({'input_text', 'output_text', 'text'} if protocol == 'responses' else {'text'})
        assert isinstance(item.get('text'), str)
        parts.append(item['text'])
    return parts


def validate_envelope(body, contract):
    assert isinstance(body, dict) and body.get('model') == MODEL
    assert type(body.get('stream', False)) is bool and body.get('stream', False) == contract['stream']
    if contract['tools'] == 'codex-fixed-functions':
        # This single reviewed definition is declarative only. The Codex relay
        # must buffer and reject every callable response before native delivery.
        assert contract['protocol'] == 'responses'
        expected = 'c02c1f46148c20f253d78c3ef8ce36621125b5270545e5fde673dd253da50e7a'
        assert contract['toolsSha256'] == expected
        assert digest(json.dumps(body.get('tools'), sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()) == expected
        assert body.get('tool_choice') == 'auto'
    else:
        assert contract['tools'] == 'none' and not body.get('tools')
        assert body.get('tool_choice') in (None, 'none')
    assert not body.get('functions') and body.get('function_call') in (None, 'none')
    assert not body.get('previous_response_id') and not body.get('conversation')
    assert not body.get('background')


def validate_body(body, contract):
    protocol = contract['protocol']
    messages = body['input'] if protocol == 'responses' else body['messages']
    assert isinstance(messages, list)
    history, systems = [], []
    for message in messages:
        assert isinstance(message, dict)
        assert message.get('type', 'message') == 'message'
        role = message.get('role')
        assert role in ('user', 'assistant', 'system', 'developer')
        assert not message.get('tool_calls') and not message.get('function_call') and not message.get('tool_call_id')
        parts = content_parts(message['content'], protocol)
        if role in ('system', 'developer'):
            systems.append({'role': role, 'sha256': digest('\n'.join(parts).encode())})
            continue
        if protocol == 'anthropic':
            history.extend({'role': role, 'text': part} for part in parts)
        else:
            history.append({'role': role, 'text': '\n'.join(parts)})
    expected = contract['history'] + [{'role': 'user', 'text': contract['prompt']}]
    if contract.get('claudeNoticeNewline', False):
        assert protocol == 'anthropic' and len(expected) > 2 and expected[0]['role'] == expected[1]['role'] == 'user'
        if history and history[0] == {'role': 'user', 'text': expected[0]['text'] + '\n'}:
            history[0] = expected[0]
    assert history == expected, 'Model-visible role/text/order/prompt mismatch'
    if body.get('system') is not None:
        assert protocol == 'anthropic'
        systems.append({'role': 'system', 'sha256': digest('\n'.join(content_parts(body['system'], protocol)).encode())})
    if body.get('instructions') is not None:
        assert protocol == 'responses' and isinstance(body['instructions'], str)
        systems.append({'role': 'instructions', 'sha256': digest(body['instructions'].encode())})
    return {'historyValidated': True, 'sessionId': contract['sessionId'], 'nativeSystemDigests': systems}


class OnceRelay:
    def __init__(self, contract_path, snapshot, *, offline=False, validator=None,
                 mock_status=500, _connection_factory=None):
        self.path = Path(contract_path).resolve()
        assert self.path.is_file() and not Path(contract_path).is_symlink()
        assert not self.path.stat().st_mode & 0o077 and not self.path.parent.stat().st_mode & 0o077
        self.raw = self.path.read_bytes()
        self.contract = json.loads(self.raw)
        c = self.contract
        assert c['schemaVersion'] == 1 and c['protocol'] in ROUTES and c['model'] == MODEL
        assert type(c['stream']) is bool
        assert c['tools'] == 'none' or (c['protocol'] == 'responses' and c['tools'] == 'codex-fixed-functions'
            and c.get('toolsSha256') == 'c02c1f46148c20f253d78c3ef8ce36621125b5270545e5fde673dd253da50e7a')
        if c['tools'] == 'codex-fixed-functions':
            assert validator is not None and type(self).forward is not OnceRelay.forward, 'Codex policy requires a buffered response guard'
        assert re.fullmatch(r'[A-Za-z0-9_-]+', c['sessionId'])
        assert c['providerFingerprint'] == snapshot.fingerprint
        assert isinstance(c['history'], list) and len(c['history']) >= 2
        assert all(set(row) == {'role', 'text'} and row['role'] in ('user', 'assistant') and isinstance(row['text'], str) for row in c['history'])
        assert isinstance(c['prompt'], str) and c['prompt']
        self.snapshot, self.offline, self.validator = snapshot, offline, validator
        assert (offline and snapshot._database is None) or (not offline and snapshot._database is not None)
        assert offline or _connection_factory is None
        self._factory, self.mock_status = _connection_factory, mock_status
        self.client_token = secrets.token_urlsafe(32)
        self._lock = threading.Lock()
        self._sockets = set()
        self._clients = set()
        self.stop_event = threading.Event()
        self._state = {'admitted': 0, 'blocked': 0, 'dispatchAttempts': 0, 'responses': [], 'offline': offline}
        self._threads = set()
        owner = self
        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            def log_message(self, *_args): pass
            def setup(self):
                super().setup()
                self.connection.settimeout(15)
                with owner._lock:
                    self._rejected = owner.stop_event.is_set()
                    if not self._rejected:
                        owner._clients.add(self.connection)
                        owner._threads.add(threading.current_thread())
                if self._rejected:
                    self.connection.close()
            def handle(self):
                if not self._rejected:
                    super().handle()
            def finish(self):
                try:
                    super().finish()
                except OSError:
                    pass
                finally:
                    with owner._lock:
                        owner._clients.discard(self.connection)
                        owner._threads.discard(threading.current_thread())
            def do_POST(self):
                try:
                    assert not self.headers.get('transfer-encoding')
                    lengths = self.headers.get_all('content-length') or []
                    assert len(lengths) == 1
                    length = int(lengths[0])
                    assert 0 < length <= 8 * 1024 * 1024
                    raw = self.rfile.read(length)
                    assert len(raw) == length
                    query = owner.admit(self.path, self.headers, raw)
                    status, content_type, response = owner.forward(raw, self.headers, query)
                    if 300 <= status < 400:
                        status, content_type, response = 502, 'application/json', b'{"error":"Redirect refused by one-shot relay"}'
                    self.send_response(status)
                    self.send_header('Content-Type', content_type)
                    self.send_header('Content-Length', str(len(response)))
                    self.send_header('Connection', 'close')
                    self.end_headers()
                    self.wfile.write(response)
                except Exception as exc:
                    with owner._lock:
                        owner._state['blocked'] += 1
                    owner.record(event='blocked-or-transport-error', errorType=type(exc).__name__)
                    try:
                        self.send_error(409, 'One-shot request rejected; do not retry')
                    except OSError:
                        pass
                finally:
                    self.close_connection = True
            def do_GET(self):
                self.send_error(405)
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self):
        return f'http://127.0.0.1:{self.server.server_port}/session/{self.contract["sessionId"]}' + ROUTES[self.contract['protocol']][0]

    @property
    def sandbox_profile(self):
        return f'(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:{self.server.server_port}"))'

    @property
    def route(self):
        return urlsplit(self.base_url).path + ROUTES[self.contract['protocol']][1]

    def redact(self, data):
        for secret in (self.snapshot._credential, self.client_token):
            data = data.replace(secret.encode(), b'[REDACTED]')
        return data

    def record(self, **event):
        event['at'] = time.time()
        encoded = json.dumps(event, ensure_ascii=False).encode()
        assert self.redact(encoded) == encoded
        with self._lock:
            with (self.path.parent / 'relay-events.jsonl').open('ab') as out:
                out.write(encoded + b'\n')

    def recheck_provider(self):
        if not self.offline:
            current = load_current_provider(self.snapshot._database)
            assert current.fingerprint == self.snapshot.fingerprint, 'Provider selection changed'

    def admit(self, route, headers, raw):
        with self._lock:
            assert not self.stop_event.is_set()
        assert self.path.read_bytes() == self.raw
        parsed = urlsplit(route)
        assert not parsed.scheme and not parsed.netloc and not parsed.fragment
        assert parsed.path == self.route
        assert parsed.query in (('', 'beta=true') if self.contract['protocol'] == 'anthropic' else ('',))
        bearer = headers.get_all('Authorization') or []
        api_key = headers.get_all('x-api-key') or []
        assert (bearer == ['Bearer ' + self.client_token] and not api_key) or (not bearer and api_key == [self.client_token])
        assert self.redact(raw) == raw, 'Credential in model body'
        body = json.loads(raw)
        validate_envelope(body, self.contract)
        proof = (self.validator or validate_body)(body, self.contract)
        assert isinstance(proof, dict) and proof.get('historyValidated') is True and proof.get('sessionId') == self.contract['sessionId']
        self.recheck_provider()
        with self._lock:
            assert not self.stop_event.is_set()
            private_json(self.path.parent / 'dispatch-token.json', {
                'contractSha256': digest(self.raw), 'requestSha256': digest(raw),
                'providerFingerprint': self.snapshot.fingerprint, 'sessionId': self.contract['sessionId']})
            self._state['admitted'] += 1
        private_json(self.path.parent / 'reviewed-request.json', body)
        private_json(self.path.parent / 'validation.json', proof)
        return parsed.query

    def forward(self, raw, headers, query=''):
        if self.offline and self._factory is None:
            response = json.dumps({'type': 'error', 'error': {'type': 'api_error', 'message': 'Synthetic offline one-shot failure'}}).encode()
            self.record(event='mock-response', status=self.mock_status, requestSha256=digest(raw))
            return self.mock_status, 'application/json', response
        self.recheck_provider()
        factory = self._factory or http.client.HTTPSConnection
        conn = factory('api.deepseek.com', 443, timeout=2, context=ssl.create_default_context())
        conn.auto_open = 0  # HTTPConnection must not reconnect a cancelled socket.
        owned_socket = None
        try:
            conn.connect()
            owned_socket = conn.sock
            with self._lock:
                assert not self.stop_event.is_set(), 'Cancelled during connect'
                owned_socket.settimeout(150)
                self._sockets.add(owned_socket)
            self.recheck_provider()
            outgoing = {key: value for key, value in headers.items() if key.lower() not in {
                'authorization', 'x-api-key', 'proxy-authorization', 'host', 'connection',
                'content-length', 'transfer-encoding', 'proxy-connection', 'accept-encoding'}}
            outgoing['Authorization'] = 'Bearer ' + self.snapshot._credential
            outgoing['Content-Type'] = 'application/json'
            with self._lock:
                assert not self.stop_event.is_set(), 'Cancelled before dispatch'
                self._state['dispatchAttempts'] += 1
            self.record(event='dispatch', requestSha256=digest(raw))
            path = ROUTES[self.contract['protocol']][2] + ('?' + query if query else '')
            conn.request('POST', path, body=raw, headers=outgoing)
            response = conn.getresponse()
            with self._lock:
                self._state['responses'].append(response.status)
            self.record(event='response-headers', status=response.status)
            if 300 <= response.status < 400:
                return response.status, 'application/json', b''
            content = response.read(16 * 1024 * 1024 + 1)
            assert len(content) <= 16 * 1024 * 1024
            assert self.redact(content) == content, 'Secret echoed by upstream; response withheld'
            fd = os.open(self.path.parent / 'upstream-response.body', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as out:
                out.write(content)
            self.record(event='response-complete', status=response.status, bytes=len(content), sha256=digest(content))
            return response.status, response.getheader('Content-Type', 'application/json'), content
        finally:
            if owned_socket is not None:
                with self._lock:
                    self._sockets.discard(owned_socket)
                owned_socket.close()
            conn.close()

    def summary(self):
        with self._lock:
            return {**self._state, 'responses': list(self._state['responses']),
                    'stopped': self.stop_event.is_set(), 'activeSockets': len(self._sockets),
                    'activeClients': len(self._clients),
                    'activeHandlers': len(self._threads), 'tokenConsumed': (self.path.parent / 'dispatch-token.json').exists()}

    def start(self):
        self.thread.start()
        return self

    def close(self):
        self.stop_event.set()
        with self._lock:
            for sock in self._sockets | self._clients:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                sock.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            with self._lock:
                active = list(self._threads)
            if not active:
                break
            for thread in active:
                thread.join(timeout=.05)
        assert not self.thread.is_alive()
        with self._lock:
            assert not self._threads and not self._clients and not self._sockets, 'Relay owned connections remain'


def start_relay(contract_path, snapshot, *, offline=False, validator=None, **kwargs):
    return OnceRelay(contract_path, snapshot, offline=offline, validator=validator, **kwargs).start()
