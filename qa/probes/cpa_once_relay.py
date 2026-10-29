"""QA-only loopback relay for native clients without a fail-closed fetch hook.

No CLI patch, no identity rewriting, no free-tier endpoint. Call start_relay with a
process-only existing CPA client credential. This module never reads credentials.
"""
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import threading
import socket
import time
import re
import importlib.util
import stat
from urllib.parse import urlparse

MODEL = 'relay/claude-opus-5-5'
POLICY = {'requestRetry': 0, 'maxRetryCredentials': 1, 'streamBootstrapRetries': 0,
          'credentialOverrides': False, 'ccSwitchRectifierEnabled': False, 'ccSwitchAutoFailoverEnabled': False,
          'quotaSwitchProject': False, 'quotaSwitchPreviewModel': False}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify_window(path):
    proof = Path(path)
    assert proof.is_absolute() and not proof.is_symlink() and stat.S_ISREG(proof.lstat().st_mode)
    assert proof.stat().st_mode & 0o077 == 0 and proof.parent.stat().st_mode & 0o077 == 0
    assert not proof.parent.is_symlink()
    data = json.loads(proof.read_text())
    from datetime import datetime, timezone
    assert data['schemaVersion'] == 1 and data['status'] == 'open'
    assert data['endpoint'] == 'http://127.0.0.1:8317' and data['model'] == MODEL
    assert datetime.fromisoformat(data['expiresAt'].replace('Z', '+00:00')) > datetime.now(timezone.utc)
    assert all(data['retryPolicy'].get(k) == v for k, v in POLICY.items())
    # Reuse the supervisor's read-only audit, including nested/provider retry and
    # quota/failover overrides. Never expose a YAML parse error with private lines.
    spec = importlib.util.spec_from_file_location('qa_retry_window_check', Path(__file__).with_name('temporary-retry-window.py'))
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
        module.check_overrides()
        config = module.yaml.safe_load(module.CPA.read_text())
        assert all(module.lookup(config, key) == value for key, value in module.FIELDS.items())
        rectifier = json.loads(module.cc_read() or '{}')
        assert rectifier.get('enabled', True) is False
    except Exception:
        raise RuntimeError('Active retry window configuration verification failed') from None


def text(content):
    if isinstance(content, str):
        return content
    assert isinstance(content, list) and all(p.get('type') == 'text' and isinstance(p.get('text'), str) for p in content)
    return '\n'.join(p['text'] for p in content)


class OnceRelay:
    def __init__(self, contract_path, credential, *, offline=False):
        self.path = Path(contract_path).absolute()
        assert self.path.is_file() and not self.path.is_symlink()
        assert not self.path.parent.is_symlink() and self.path.parent.is_dir()
        assert self.path.parent.stat().st_mode & 0o077 == 0
        assert isinstance(credential, str) and credential
        self.raw = self.path.read_bytes()
        self.contract = json.loads(self.raw)
        self.credential = credential
        self.offline = offline
        self._lock = threading.Lock()
        self._closed = False
        self._sockets = set()
        c = self.contract
        self.upstream = urlparse(c['endpoint'])
        assert self.upstream.scheme == 'http' and self.upstream.hostname == '127.0.0.1' and self.upstream.port
        assert self.upstream.path == '/v1/chat/completions' and not self.upstream.query and not self.upstream.fragment
        assert not self.upstream.username and not self.upstream.password
        assert c['model'] == MODEL and isinstance(c['stream'], bool)
        assert isinstance(c['sessionId'], str) and re.fullmatch(r'[A-Za-z0-9_-]+', c['sessionId'])
        assert c['route'] == '/session/' + c['sessionId'] + '/v1/chat/completions'
        assert isinstance(c['history'], list) and len(c['history']) >= 2
        assert all(m['role'] in ('user', 'assistant') and isinstance(m['text'], str) for m in c['history'])
        assert isinstance(c['prompt'], str) and c['prompt']
        if not offline:
            assert c['endpoint'] == 'http://127.0.0.1:8317/v1/chat/completions'
            verify_window(c['retryWindow'])
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_args):
                pass

            def do_POST(self):
                self.connection.settimeout(30)
                try:
                    length = int(self.headers.get('content-length', '-1'))
                    assert 0 < length <= 8 * 1024 * 1024 and not self.headers.get('transfer-encoding')
                    raw = self.rfile.read(length)
                    assert len(raw) == length
                    owner.admit(self.path, self.headers, raw)
                except Exception as error:
                    owner.record(event='blocked', errorType=type(error).__name__, route=self.path, tokenConsumed=(owner.path.parent/'dispatch-token.json').exists())
                    self.send_error(409, 'QA request not admitted')
                    return
                conn = http.client.HTTPConnection(owner.upstream.hostname, owner.upstream.port, timeout=1)
                owned_socket = None
                try:
                    # Connect outside the cleanup lock with a short finite timeout.
                    # A concurrent close prevents dispatch when connect returns.
                    conn.connect()
                    owned_socket = conn.sock
                    with owner._lock:
                        assert not owner._closed
                        owned_socket.settimeout(150)
                        owner._sockets.add(owned_socket)
                    # Preserve native identity/authorization headers; remove only hop-by-hop framing.
                    headers = {k: v for k, v in self.headers.items() if k.lower() not in
                               ('host', 'connection', 'content-length', 'transfer-encoding', 'proxy-connection')}
                    if not owner.offline:
                        verify_window(owner.contract['retryWindow'])
                    owner.record(event='dispatch', requestHash=digest(raw))
                    conn.request('POST', '/v1/chat/completions', body=raw, headers=headers)
                    response = conn.getresponse()
                    owner.record(event='response', status=response.status)
                    # Never expose redirect Location to a native client: it could bypass this relay.
                    if 300 <= response.status < 400:
                        self.send_error(502, 'QA refuses upstream redirect')
                        return
                    self.send_response(response.status)
                    self.send_header('content-type', response.getheader('content-type', 'application/json'))
                    self.send_header('connection', 'close')
                    self.end_headers()
                    while chunk := response.read1(65536):
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    self.close_connection = True
                except Exception as error:
                    owner.record(event='transport-error', errorType=type(error).__name__)
                    self.close_connection = True
                finally:
                    conn.close()
                    if owned_socket is not None:
                        with owner._lock:
                            owner._sockets.discard(owned_socket)

            def do_GET(self):
                self.send_error(405)

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self):
        return f'http://127.0.0.1:{self.server.server_port}/session/{self.contract["sessionId"]}/v1'

    def record(self, **event):
        event['at'] = time.time()
        with (self.path.parent / 'relay-events.jsonl').open('a') as log:
            log.write(json.dumps(event) + '\n')

    def admit(self, route, headers, raw):
        with self._lock:
            assert not self._closed
        assert self.path.read_bytes() == self.raw
        assert headers.get_all('Authorization') == ['Bearer ' + self.credential]
        assert self.credential.encode() not in raw
        if self.offline:
            (self.path.parent / "offline-candidate.json").write_bytes(raw)
        assert route == self.contract['route']
        body = json.loads(raw)
        assert body['model'] == MODEL and type(body.get('stream', False)) is bool
        assert body.get('stream', False) == self.contract['stream']
        assert not body.get('tools') and not body.get('functions')
        messages = [{'role': m['role'], 'text': text(m['content'])} for m in body['messages'] if m['role'] != 'system']
        assert messages == self.contract['history'] + [{'role': 'user', 'text': self.contract['prompt']}]
        if not self.offline:
            verify_window(self.contract['retryWindow'])
        token = self.path.parent / 'dispatch-token.json'
        fd = os.open(token, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            data = json.dumps({'contractHash': digest(self.raw), 'requestHash': digest(raw),
                               'sessionId': self.contract['sessionId'], 'model': MODEL}).encode()
            with os.fdopen(fd, 'wb') as out:
                out.write(data); out.flush(); os.fsync(out.fileno())
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except Exception:
            # Consumed token survives every failure; do not recover by deleting it.
            raise
        (self.path.parent / 'reviewed-request.json').write_bytes(raw)

    def start(self):
        self.thread.start()
        return self

    def close(self):
        # Cancel only sockets created by this relay before the global retry window
        # may restore. Keeping the raw socket also covers HTTPResponse ownership.
        with self._lock:
            self._closed = True
            for owned_socket in self._sockets:
                try:
                    owned_socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                owned_socket.close()
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=3)
        assert not self.thread.is_alive()
