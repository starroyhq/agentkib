"""One fixed Hermes continuation through the direct DeepSeek one-dispatch relay.

Default --mode mock runs only a SQLite backup, synthetic provider and in-memory
response transport. --mode live is an explicit real-model action, never a check.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import ssl
import subprocess
import sys
import threading

HERE = Path(__file__).resolve().parent
HELPER_NAMES = ('deepseek_once_relay.py', 'qa_owned_cli.py', 'qa_native_sqlite.py',
                'interop_native_readback.py', 'native-offline-tui.py')
HELPER_SOURCES = {name: (HERE / name).read_bytes() for name in HELPER_NAMES}

from deepseek_once_relay import MODEL, load_current_provider, private_json, start_relay, synthetic_provider
from interop_native_readback import validate_receipts, verify, verify_native_source
from qa_native_sqlite import decode, encode, read_hermes_state, write_snapshot
from qa_owned_cli import run_owned_cli

spec = importlib.util.spec_from_file_location('native_offline', HERE / 'native-offline-tui.py')
native_offline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native_offline)
PROMPT = 'Recall the exact random marker and complete project storage decision from our previous history. Reply with those values only. Do not use tools.'
PROVIDER = 'agentkib-deepseek-once'
KEY_ENV = 'AGENTKIB_QA_LOOPBACK_KEY'
CA_FILE = Path('/Users/user/Library/Python/3.11/lib/python/site-packages/certifi/cacert.pem')
CA_SHA256 = 'c55b21f907f7f86d48add093552fb5651749ff5f860508ccbb423d6c1fbd80c7'


class DeferredCancellation:
    """Keep cancellation observable while bounded cleanup and audits complete."""
    def __init__(self):
        self.signals = []
        self.previous = {}

    def install(self):
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            self.previous[signum] = signal.signal(signum, self.record)

    def record(self, signum, _frame):
        self.signals.append(signum)

    def checkpoint(self):
        if self.signals:
            raise SystemExit(128 + self.signals[0])

    def finalize(self, result):
        result['supervisorCancellationSignals'] = list(self.signals)
        if self.signals or result.get('cancellationSignals'):
            result['passed'] = result['realReplyPassed'] = result['syntheticMockReplyPassed'] = False
            result['cancelled'] = True

    def restore(self):
        for signum, handler in self.previous.items():
            signal.signal(signum, handler)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def assert_clean(rows, total, history):
    assert total == 1, 'Unexpected native session count'
    assert [{'role': row['role'], 'text': row['content']} for row in rows] == history, 'Target contains changed history or an old continuation; do not reset or reimport'


def assert_continuation(before, after, total, prompt):
    assert total == 1 and after[:len(before)] == before, 'Native prefix or identity changed'
    added = after[len(before):]
    assert all(row['role'] in ('user', 'assistant') for row in added), 'Unexpected tool or other native message'
    assert all(not row.get('tool_calls') and not row.get('tool_call_id') and not row.get('tool_name') for row in added), 'Unexpected native tool-call metadata'
    users = [row for row in added if row['role'] == 'user']
    assert len(users) == 1 and users[0]['content'] == prompt, 'Expected exactly one new prompt'
    return '\n'.join(row['content'] or '' for row in added if row['role'] == 'assistant')


def override_config(base_url):
    return json.dumps({'updates': {'check': False},
        # Fixed QA budget avoids Hermes probing a loopback custom endpoint as
        # Ollama (/api/show). This is not a claim about the provider's maximum.
        'model': {'provider': PROVIDER, 'default': MODEL, 'base_url': base_url, 'context_length': 65536},
        'providers': {PROVIDER: {'base_url': base_url, 'key_env': KEY_ENV,
                               'default_model': MODEL, 'api_mode': 'chat_completions'}},
        'toolsets': [], 'platform_toolsets': {'cli': []}, 'mcp_servers': {},
        'agent': {'api_max_retries': 1, 'auto_recovery_cycles': 0},
        'compression': {'enabled': False},
        'memory': {'memory_enabled': False, 'user_profile_enabled': False}}).encode()


def claim_live_case(case, attempt, session_id, plan_hash, provider_fingerprint):
    private_json(case / '.deepseek-hermes-live-consumed.json', {
        'attempt': str(attempt), 'sessionId': session_id, 'planHash': plan_hash,
        'providerFingerprint': provider_fingerprint, 'automaticRetryPermitted': False})


class PrivateCapture:
    """Drain a native output pipe to bounded memory; redact before disk writes."""
    def __init__(self, limit=2 * 1024 * 1024):
        self.read_fd, self.write_fd = os.pipe()
        self.data = bytearray()
        self.limit = limit
        self.exceeded = threading.Event()
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        try:
            while chunk := os.read(self.read_fd, 65536):
                room = self.limit - len(self.data)
                self.data.extend(chunk[:room])
                if len(chunk) > room:
                    self.exceeded.set()
        finally:
            os.close(self.read_fd)

    def finish(self, path, redact):
        os.close(self.write_fd)
        self.thread.join(timeout=4)
        assert not self.thread.is_alive(), 'Native output pipe still owned by a descendant'
        clean = redact(bytes(self.data))
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as out:
            out.write(clean)
        return clean


def mock_transport(reply, status=200):
    """Synthetic transport, no socket/connect implementation and no real provider."""
    payload = (('data: ' + json.dumps({'id': 'qa-synthetic', 'object': 'chat.completion.chunk',
        'model': MODEL, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': reply}, 'finish_reason': None}]})
        + '\n\ndata: ' + json.dumps({'id': 'qa-synthetic', 'object': 'chat.completion.chunk', 'model': MODEL,
        'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]}) + '\n\ndata: [DONE]\n\n').encode()
        if status == 200 else b'{"error":{"message":"Synthetic offline failure","type":"api_error"}}')
    class Socket:
        def settimeout(self, _): pass
        def shutdown(self, _): pass
        def close(self): pass
    class Response:
        def __init__(self): self.status = status
        def getheader(self, *_): return 'text/event-stream' if status == 200 else 'application/json'
        def read(self, _): return payload
    class Connection:
        def __init__(self, *_args, **_kwargs): self.sock = None
        def connect(self): self.sock = Socket()
        def request(self, method, path, body, headers):
            assert method == 'POST' and path == '/chat/completions'
        def getresponse(self): return Response()
        def close(self): pass
    return Connection


def native_reply_matches(native_results, reply, sid, relay_summary):
    return (len(native_results) == 1 and native_results[0].get('exit_code') == 0
            and not native_results[0].get('error') and native_results[0].get('session_id') == sid
            and native_results[0].get('text') == reply and relay_summary['blocked'] == 0)


def scan_private(paths, relay, frozen_sources=None, mock=False):
    scanned = 0
    for root in paths:
        for path in root.rglob('*'):
            if path.is_file() and not path.is_symlink():
                assert path.stat().st_size <= 128 * 1024 * 1024, 'Evidence too large for bounded secret scan'
                content = path.read_bytes()
                if mock and path in (frozen_sources or {}):
                    assert content == frozen_sources[path], 'Frozen helper source changed'
                    # Only the exact public synthetic fixture inside verified code
                    # is exempt; random native tokens and real keys remain strict.
                    content = content.replace(synthetic_provider()._credential.encode(), b'[STATIC-OFFLINE-FIXTURE]')
                assert relay.redact(content) == content, 'A private credential/token reached a native or evidence file'
                scanned += 1
    return scanned


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('case', type=Path)
    parser.add_argument('attempt', type=Path)
    parser.add_argument('--mode', choices=['mock', 'live'], default='mock')
    parser.add_argument('--mock-status', type=int, choices=[200, 500], default=200)
    args = parser.parse_args()
    case, attempt = args.case.resolve(), args.attempt.resolve()
    os.umask(0o077)
    attempt.mkdir(mode=0o700, parents=True, exist_ok=False)
    private_json(attempt / 'attempt.json', {'mode': args.mode, 'case': str(case), 'singleNativePrompt': True})
    source_code = Path(__file__).read_bytes()
    (attempt / 'runner.py').write_bytes(source_code)
    result = {'mode': args.mode, 'passed': False, 'realReplyPassed': False,
              'runnerSha256': digest(source_code), 'model': MODEL, 'target': 'hermes'}
    relay = None
    audit = None
    frozen_sources = {}
    cancellation = DeferredCancellation()
    cancellation.install()
    try:
        prior = json.loads((case / 'result.json').read_text())
        validate_receipts(prior)
        operation, = prior['operations']
        sid = operation['target_session_id']
        plan_file, = (case / 'data/continuations').rglob('plan.json')
        raw_plan = plan_file.read_bytes(); plan = json.loads(raw_plan)
        receipt = json.loads(plan_file.with_name('receipt.json').read_text())
        assert prior['target'] == plan['target_agent'] == 'hermes'
        assert plan['version'] == '0.21.5' and plan['target_profile'] == 'default'
        assert digest(raw_plan) == operation['launch_request']['plan_hash'] == receipt['plan_hash']
        assert receipt['target_session_id'] == sid and receipt['verified'] and receipt['launched']
        original_home = Path(plan['target_home'])
        assert original_home == case / 'hermes'
        artifacts = attempt / 'implementation'; artifacts.mkdir(mode=0o700)
        implementation = {}
        for name, data in HELPER_SOURCES.items():
            assert (HERE / name).read_bytes() == data, 'Helper changed after import'
            artifact = artifacts / name; artifact.write_bytes(data)
            frozen_sources[artifact] = data
            implementation[name] = {'path': str(HERE / name), 'sha256': digest(data)}
        entry = Path(plan['executable']); entry_bytes = entry.read_bytes()
        (artifacts / 'hermes-entry').write_bytes(entry_bytes)
        implementation['nativeEntry'] = {'path': str(entry), 'sha256': digest(entry_bytes)}
        result['implementation'] = implementation
        history = [{'role': turn['role'], 'text': '\n'.join(block['text'] for block in turn['blocks'])}
                   for turn in plan['expected']['turns']]
        assert all(block['type'] == 'text' for turn in plan['expected']['turns'] for block in turn['blocks'])
        assert prior['marker'] not in PROMPT and prior['decision'] not in PROMPT
        original_rows, total = read_hermes_state(original_home, sid)
        assert_clean(original_rows, total, history)
        before_verify = attempt / 'before-verification'; before_verify.mkdir(mode=0o700)
        result['beforeVerification'] = verify(case, evidence_dir=before_verify)
        env = native_offline.isolated_environment(case)
        for key in ('HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'): env.pop(key, None)
        original_env = dict(env)
        result.update(sessionId=sid, originalTargetHome=str(original_home), historyTurns=len(history))
        home, workspace = original_home, Path(plan['workspace'])
        original_db_hash = digest((original_home / 'state.db').read_bytes())
        if args.mode == 'mock':
            home = attempt / 'mock-hermes'; home.mkdir(mode=0o700)
            workspace = attempt / 'workspace'; workspace.mkdir(mode=0o700)
            with sqlite3.connect('file:' + str(original_home / 'state.db') + '?mode=ro', uri=True) as source:
                with sqlite3.connect(home / 'state.db') as destination: source.backup(destination)
            for key in native_offline.PATH_KEYS & set(env):
                env[key] = str(attempt / 'isolated' / Path(env[key]).relative_to(case))
            env['HERMES_HOME'] = str(home)
            (home / 'config.yaml').write_bytes(b'updates:\n  check: false\n')
        config = home / 'config.yaml'
        original = config.read_bytes()
        assert original == b'updates:\n  check: false\n', 'Unexpected isolated config; preserve and inspect'
        (attempt / 'original-config.yaml').write_bytes(original)
        before, total = read_hermes_state(home, sid); assert_clean(before, total, history)
        write_snapshot(attempt / 'before-native.json', before)
        audited = None

        def audit_native():
            nonlocal audited
            if audited is not None: return audited
            after, count = read_hermes_state(home, sid)
            if relay is not None:
                serialized = json.dumps(encode(after)).encode()
                assert relay.redact(serialized) == serialized, 'Credential in native transcript'
            write_snapshot(attempt / 'after-native.json', after)
            result['importedPrefixUnchanged'] = after[:len(before)] == before
            result['nativeSessionCount'] = count
            result['nativeSuffixRoles'] = [row['role'] for row in after[len(before):]]
            result['configBytesRestored'] = config.read_bytes() == original
            verify_native_source(prior, original_env)
            result['sourceUnchanged'] = (digest(Path(prior['source']).read_bytes()) == prior['sourceSha256'] and
                all(digest(Path(item['path']).read_bytes()) == item['sha256'] for item in prior.get('sourceMetadata', [])))
            if args.mode == 'mock':
                result['originalTargetUnchanged'] = (read_hermes_state(original_home, sid) == (original_rows, 1)
                    and digest((original_home / 'state.db').read_bytes()) == original_db_hash)
            if result.get('ownedCliPid') is not None:
                result['ownedProcessGroupGone'] = not native_offline.group_exists(result['ownedCliPid'])
            readback_code = ('import json,sys;sys.path.insert(0,sys.argv[1]);'
                'from qa_native_sqlite import encode,read_hermes_state;'
                'print(json.dumps(encode(read_hermes_state(sys.argv[2],sys.argv[3]))))')
            readback = native_offline.run_owned(native_offline.SANDBOX + [sys.executable, '-c', readback_code,
                str(HERE), str(home), sid], env, str(workspace), attempt / 'readonly-restart.ansi', timeout=15)
            assert readback['ownedProcessGroupGone'] and readback['exitCodeAfterCleanup'] == 0
            final, final_count = decode(json.loads((attempt / 'readonly-restart.ansi').read_text()))
            result['independentReadbackStable'] = final == after and final_count == count
            export = native_offline.run_owned(native_offline.SANDBOX + [plan['executable'], '--profile',
                'default', 'sessions', 'export', '-', '--session-id', sid, '--format', 'jsonl'],
                env, str(workspace), attempt / 'official-export.ansi', timeout=20)
            assert export['ownedProcessGroupGone'] and export['exitCodeAfterCleanup'] == 0
            exported = json.loads((attempt / 'official-export.ansi').read_text())
            result['officialCliExport'] = export
            result['officialCliExportExact'] = (exported['id'] == sid and
                [(row['role'], row['content']) for row in exported['messages']] ==
                [(row['role'], row['content']) for row in after])
            result['officialCliExportPreservedRows'] = read_hermes_state(home, sid) == (after, count)
            if relay is not None: result['filesScannedForSecrets'] = scan_private([attempt, home], relay, frozen_sources, args.mode == 'mock')
            assert result['importedPrefixUnchanged'] and count == 1 and result['sourceUnchanged']
            assert result['configBytesRestored'] and result['independentReadbackStable']
            assert result['officialCliExportExact'] and result['officialCliExportPreservedRows']
            assert args.mode != 'mock' or result['originalTargetUnchanged']
            assert result.get('ownedProcessGroupGone', True)
            audited = after, count
            return audited

        audit = audit_native
        version = native_offline.run_owned(native_offline.SANDBOX + [plan['executable'], '--version'],
            env, str(workspace), attempt / 'version.ansi', timeout=15)
        assert version['ownedProcessGroupGone'] and version['exitCodeAfterCleanup'] == 0
        reported = re.search(r'(?<!\d)(\d+\.\d+\.\d+)(?!\d)', (attempt / 'version.ansi').read_text())
        assert reported and reported.group(1) == '0.21.5', 'Hermes version drift'
        result['reportedVersion'] = reported.group(1)
        cancellation.checkpoint()
        if args.mode == 'live':
            assert os.environ.get('SSL_CERT_FILE') == str(CA_FILE) and digest(CA_FILE.read_bytes()) == CA_SHA256, 'Pinned QA trust bundle missing or changed'
            context = ssl.create_default_context()
            assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname
            result['upstreamTls'] = {'caFile': str(CA_FILE), 'caSha256': CA_SHA256,
                                     'certificateVerificationRequired': True, 'checkHostname': True}
        snapshot = synthetic_provider() if args.mode == 'mock' else load_current_provider()
        result['provider'] = snapshot.safe_metadata()
        contract = {'schemaVersion': 1, 'protocol': 'chat', 'model': MODEL, 'stream': True,
                    'tools': 'none', 'sessionId': sid, 'providerFingerprint': snapshot.fingerprint,
                    'history': history, 'prompt': PROMPT}
        private_json(attempt / 'contract.json', contract)
        if args.mode == 'live':
            cancellation.checkpoint()
            claim_live_case(case, attempt, sid, digest(raw_plan), snapshot.fingerprint)
            result['sourceCaseLiveAttemptClaimed'] = True
        kwargs = {'_connection_factory': mock_transport(prior['marker'] + '; ' + prior['decision'], args.mock_status)} if args.mode == 'mock' else {}
        relay = start_relay(attempt / 'contract.json', snapshot, offline=args.mode == 'mock', **kwargs)
        if args.mode == 'mock':
            original_admit = relay.admit
            def observe_rejection(route, headers, raw):
                try: return original_admit(route, headers, raw)
                except Exception:
                    path = attempt / 'mock-rejected-request.json'
                    if not path.exists():
                        private_json(path, {'route': route, 'redactedBody': relay.redact(raw).decode()})
                    raise
            relay.admit = observe_rejection
        modified = override_config(relay.base_url)
        native_env = dict(env, **{KEY_ENV: relay.client_token}, OPENAI_BASE_URL=relay.base_url,
                          HERMES_IGNORE_RULES='1', NO_PROXY='127.0.0.1,localhost')
        command = ['/usr/bin/sandbox-exec', '-p', relay.sandbox_profile, plan['executable'],
            '--profile', 'default', 'chat', '--resume', sid, '--no-restore-cwd', '--model', MODEL,
            '--provider', PROVIDER, '--query-file', '-', '--oneshot', '--format', 'stream-json', '--ignore-rules']
        result.update(command=command, isolatedHome=str(home), realCredentialPassedToNative=False,
                      nativeEnvironmentKeys=sorted(native_env), osLoopbackRelayOnly=True)
        out, err = PrivateCapture(), PrivateCapture()
        stdout = b''
        def stop_native():
            started = attempt / 'native-started.json'
            if not started.exists(): private_json(started, {'pid': result['ownedCliPid'], 'command': command})
            return bool(cancellation.signals) or relay.summary()['blocked'] > 0 or out.exceeded.is_set() or err.exceeded.is_set()
        try:
            cancellation.checkpoint()
            assert all((HERE / name).read_bytes() == data for name, data in HELPER_SOURCES.items()), 'Helper changed before dispatch'
            assert config.read_bytes() == original, 'Config changed before temporary override'
            run_owned_cli(command, env=native_env, cwd=workspace, config=config, original=original,
                modified=modified, prompt=PROMPT, stdout=out.write_fd, stderr=err.write_fd, result=result,
                should_stop=stop_native, timeout=150)
        finally:
            try:
                relay.close()
            finally:
                try: stdout = out.finish(attempt / 'run.stdout', relay.redact)
                finally:
                    err.finish(attempt / 'run.stderr', relay.redact)
                    result['relay'] = relay.summary()
        assert not out.exceeded.is_set() and not err.exceeded.is_set(), 'Native output exceeded bound'
        assert config.read_bytes() == original and result.get('isolatedConfigRestored'), 'Config restoration failed'
        assert not native_offline.group_exists(result['ownedCliPid']), 'Owned native group remains'
        result['ownedProcessGroupGone'] = True
        after, total = audit()
        assert result['relay']['admitted'] == 1, 'No admitted model request; inspect native startup and relay evidence'
        reply = assert_continuation(before, after, total, PROMPT)
        result.update(importedPrefixUnchanged=True, nativeSessionCount=total,
                      reply=relay.redact(reply.encode()).decode(), markerMatched=prior['marker'] in reply,
                      decisionMatched=prior['decision'].casefold() in reply.casefold())
        native_results = []
        for line in stdout.decode().splitlines():
            try: item = json.loads(line)
            except json.JSONDecodeError: continue
            if item.get('type') == 'result': native_results.append(item)
        result['cliResults'] = native_results
        success = (result['markerMatched'] and result['decisionMatched'] and result['cliExitCode'] == 0
                   and sum(row['role'] == 'assistant' for row in after[len(before):]) == 1
                   and native_reply_matches(native_results, reply, sid, result['relay'])
                   and result['relay']['dispatchAttempts'] == result['relay']['admitted'] == 1
                   and result['relay']['responses'] == [200])
        result['realReplyPassed'] = success and args.mode == 'live'
        result['syntheticMockReplyPassed'] = success and args.mode == 'mock'
        result['passed'] = success if args.mock_status == 200 or args.mode == 'live' else (
            result['relay']['dispatchAttempts'] == result['relay']['admitted'] == 1 and result['relay']['responses'] == [500])
    except BaseException as exc:
        result['errorType'] = type(exc).__name__
        message = str(exc).encode()
        result['error'] = (relay.redact(message) if relay else message).decode()
    finally:
        try:
            if relay is not None and not relay.stop_event.is_set(): relay.close()
        finally:
            if audit is not None:
                try: audit()
                except BaseException as exc:
                    result['passed'] = result['realReplyPassed'] = False
                    result['auditErrorType'] = type(exc).__name__
            cancellation.finalize(result)
            try:
                private_json(attempt / 'result.json', result)
            finally:
                cancellation.restore()
    print(json.dumps({key: result.get(key) for key in ['mode', 'passed', 'realReplyPassed', 'syntheticMockReplyPassed', 'errorType', 'error']}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
