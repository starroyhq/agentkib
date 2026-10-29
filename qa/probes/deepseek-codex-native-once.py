"""Pinned Codex one-turn QA. Default mock never contacts a provider.

Mock fixtures contain only frozen renderer JSONL, never SQLite absolute paths.
Live is an explicit separate action on the fixed clean public Grok import.
"""
import argparse
import dataclasses
from datetime import datetime
import importlib.util
import json
import os
from pathlib import Path
import select
import secrets
import signal
import ssl
import sqlite3
import subprocess
import sys
import time
from zoneinfo import ZoneInfo

from deepseek_once_relay import MODEL, digest, load_current_provider, private_json, synthetic_provider
from deepseek_codex_guard import (CodexRelay, POLICY, TOOLS_SHA, make_projection,
                                  strict_json, synthetic_sse, synthetic_transport)
from codex_qa_profiles import BATCH, PROFILES, binary_profile, public_snapshot

HERE = Path(__file__).resolve().parent
ROOT = Path('/Users/user/Documents/AgentKib-archives/2026-10-01/provider-retest/Codex')
CASE = Path('/Users/user/Documents/AgentKib-archives/2026-09-30/full-interop/offline-grok-build-to-codex')
BINARY = Path('/Users/user/Documents/AgentKib-archives/2026-09-30/full-interop/tools-codex146/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex')
BINARY_SHA = '35d248101b211d6248ad4e6b8c1d441fe81236da87afb9f3e9ea51a049e9f179'
CA = Path('/Users/user/Library/Python/3.11/lib/python/site-packages/certifi/cacert.pem')
CA_SHA = 'c55b21f907f7f86d48add093552fb5651749ff5f860508ccbb423d6c1fbd80c7'
PROMPT = 'Recall the exact random marker and complete project storage decision from our previous history. Reply with those values only. Do not use tools.'
SPEC = importlib.util.spec_from_file_location('codex_owned', HERE / 'native-offline-tui.py')
OWNED = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(OWNED)
LIMIT = 8 * 1024 * 1024


class Cancellation:
    def __init__(self): self.signals, self.previous = [], {}
    def install(self):
        for sig in OWNED.SIGNALS:
            self.previous[sig] = signal.signal(sig, self.receive)
        return self
    def receive(self, sig, _frame): self.signals.append(sig)
    def checkpoint(self):
        if self.signals: raise InterruptedError('Cancelled')
    def restore(self):
        for sig, previous in self.previous.items(): signal.signal(sig, previous)


def source_snapshot(case=CASE, expected_source='grok-build'):
    if case != CASE:
        return public_snapshot(case, expected_source)
    prior = strict_json((CASE / 'result.json').read_bytes())
    plan_raw = (CASE / 'file-plan.json').read_bytes(); plan = strict_json(plan_raw)
    launch = plan['launch_request']; target = Path(launch['target_path']).resolve()
    sid = launch['target_session_id']
    assert prior['target'] == launch['target_agent'] == 'codex' and prior['sourceAgent'] == 'grok-build'
    assert prior['first']['status'] == 'launched' and prior['reopen']['target_agent'] == 'codex'
    assert target.is_relative_to(CASE / 'codex/sessions') and sid in target.name
    payload, = [item['after'].encode() for item in plan['change_set']['changes'] if item['target'] == str(target)]
    assert target.read_bytes() == payload, 'Public target has a suffix/change; no reset or retry permitted'
    database = CASE / 'codex/state_5.sqlite'
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as db:
        assert db.execute('SELECT id,rollout_path FROM threads').fetchall() == [(sid, str(target))], 'Native index points outside the intended rollout'
    records = [strict_json(line) for line in payload.splitlines()]
    assert records[0]['type'] == 'session_meta'
    assert records[0]['payload']['id'] == sid and records[0]['payload']['cwd'] == str(CASE / 'workspace')
    history = []
    for row in records:
        if row['type'] != 'response_item': continue
        message = row['payload']
        assert message['type'] == 'message' and message['role'] in ('user', 'assistant')
        assert len(message['content']) == 1
        part, = message['content']; assert set(part) == {'type', 'text'}
        assert part['type'] == ('input_text' if message['role'] == 'user' else 'output_text')
        history.append({'role': message['role'], 'text': part['text']})
    assert [m['role'] for m in history] == ['user', 'user', 'assistant']
    assert prior['marker'] not in PROMPT and prior['decision'] not in PROMPT
    files = {prior['source']: prior['sourceSha256'], **{x['path']: x['sha256'] for x in prior['sourceMetadata']}}
    assert all(digest(Path(path).read_bytes()) == sha for path, sha in files.items())
    return prior, target, sid, payload, history, files, digest(plan_raw)


def flags(base_url):
    return {'model_provider': 'qa-deepseek', 'model_providers.qa-deepseek.name': 'Official DeepSeek QA',
        'model_providers.qa-deepseek.base_url': base_url,
        'model_providers.qa-deepseek.env_key': 'AGENTKIB_QA_LOOPBACK_KEY',
        'model_providers.qa-deepseek.wire_api': 'responses',
        'model_providers.qa-deepseek.requires_openai_auth': False,
        'model_providers.qa-deepseek.supports_websockets': False,
        'model_providers.qa-deepseek.request_max_retries': 0,
        'model_providers.qa-deepseek.stream_max_retries': 0,
        'check_for_update_on_startup': False, 'web_search': 'disabled',
        'features.shell_snapshot': False, 'features.shell_tool': False, 'features.code_mode': False,
        'features.skills': False, 'features.multi_agent': False, 'features.multi_agent_v2': False,
        'agents.enabled': False, 'features.goals': False, 'tools.update_plan.enabled': False,
        'tools.experimental_request_user_input.enabled': False, 'features.apps': False,
        'approval_policy': 'never', 'sandbox_mode': 'read-only'}


def command(overrides, sandbox, tail):
    cmd = ['/usr/bin/sandbox-exec', '-p', sandbox, str(BINARY)]
    for key, value in overrides.items(): cmd += ['-c', key + '=' + json.dumps(value)]
    return cmd + tail


def run_cli(cmd, env, cwd, prompt, cancellation, relay, result):
    child = None; buffers = [bytearray(), bytearray()]
    try:
        cancellation.checkpoint()
        child = subprocess.Popen(cmd, env=env, cwd=cwd, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        result['ownedPid'] = child.pid
        cancellation.checkpoint()
        child.stdin.write(prompt.encode()); child.stdin.close()
        streams = {child.stdout: buffers[0], child.stderr: buffers[1]}
        deadline = time.monotonic() + 180
        while streams:
            cancellation.checkpoint()
            assert time.monotonic() < deadline, 'Native deadline exceeded'
            assert relay.summary()['blocked'] == 0, 'Relay rejected request or response'
            ready, _, _ = select.select(list(streams), [], [], .1)
            for stream in ready:
                chunk = os.read(stream.fileno(), 65536)
                if not chunk: del streams[stream]; continue
                streams[stream].extend(chunk)
                assert len(streams[stream]) <= LIMIT, 'Native output bound'
        child.wait(timeout=3)
        result['naturalExitCode'] = child.returncode
    finally:
        try:
            if child is not None: result.update(OWNED.cleanup(child))
        finally:
            result['_buffers'] = buffers
            if child is not None:
                for stream in (child.stdin, child.stdout, child.stderr):
                    if stream and not stream.closed: stream.close()


def audit_cli_output(raw, sid, answer):
    events = [strict_json(line) for line in raw.splitlines() if line]
    assert [e['thread_id'] for e in events if e['type'] == 'thread.started'] == [sid]
    assert sum(e['type'] == 'turn.started' for e in events) == 1
    completed = [e for e in events if e['type'] == 'turn.completed']
    assert len(completed) == 1
    messages, warnings = [], []
    for event in events:
        assert event['type'] in ('thread.started', 'turn.started', 'turn.completed', 'item.completed')
        if event['type'] != 'item.completed': continue
        item = event['item']
        if item['type'] == 'agent_message': messages.append(item['text'])
        elif item['type'] == 'error':
            expected = f'Model metadata for `{MODEL}` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.'
            assert item['message'] == expected
            warnings.append(expected)
        elif item['type'] == 'reasoning':
            assert set(item) <= {'id', 'type', 'text'}
        else: raise AssertionError('Native tool or unexpected CLI item')
    assert messages == [answer] and len(warnings) <= 1
    usage = completed[0]['usage']
    assert all(type(value) is int and value >= 0 for value in usage.values())
    return {'nativeUsage': usage, 'nativeWarnings': warnings, 'singleNativeTurnCompleted': True}


def native_messages(response, sid, workspace, target):
    assert 'error' not in response
    thread = response['result']['thread']
    assert thread['id'] == sid and thread['cwd'] == str(workspace) and thread['path'] == str(target)
    messages = []
    for turn in thread['turns']:
        assert turn['status'] == 'completed'
        for item in turn['items']:
            if item['type'] == 'userMessage':
                assert all(p['type'] == 'text' for p in item['content'])
                messages.extend({'role': 'user', 'text': p['text']} for p in item['content'])
            elif item['type'] == 'agentMessage': messages.append({'role': 'assistant', 'text': item['text']})
            elif item['type'] == 'reasoning':
                # A recorded reasoning item is never a callable native item.
                assert set(item) <= {'type', 'id', 'summary', 'content'}
            else: raise AssertionError('Unexpected native item: ' + item['type'])
    return messages


def readback(env, workspace, sid, target, expected, attempt, index, cancellation):
    """A fresh network-denied official app-server; never turn/start."""
    # Resume resolves the persisted provider id even though no turn is sent.
    # Give it an inert definition and dummy local key under total network denial.
    overrides = flags('http://127.0.0.1:1'); overrides['model'] = MODEL
    cmd = command(overrides, '(version 1)(allow default)(deny network*)', ['app-server'])
    env = dict(env, AGENTKIB_QA_LOOPBACK_KEY='offline-readback-only')
    child = None; log = []; err = bytearray(); buffer = bytearray(); report = {'passed': False}
    def send(value):
        log.append({'direction': 'request', 'value': value})
        child.stdin.write(json.dumps(value).encode() + b'\n'); child.stdin.flush()
    sequence = 0
    def rpc(method, params):
        nonlocal sequence
        assert method in ('initialize', 'thread/read', 'thread/resume', 'thread/list')
        sequence += 1; send({'id': sequence, 'method': method, 'params': params})
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            # Final auditing still finishes after a cancellation, but is bounded.
            if b'\n' in buffer:
                line, _, rest = buffer.partition(b'\n'); buffer[:] = rest
                value = strict_json(line); log.append({'direction': 'response', 'value': value})
                assert len(json.dumps(log)) <= LIMIT, 'RPC output bound'
                if value.get('id') == sequence and 'method' not in value: return value
                assert not ('id' in value and 'method' in value), 'Unexpected server request'
                continue
            ready, _, _ = select.select([child.stdout, child.stderr], [], [], .1)
            for stream in ready:
                chunk = os.read(stream.fileno(), 65536)
                if stream is child.stderr:
                    err.extend(chunk); assert len(err) <= LIMIT
                else:
                    assert chunk, 'Native app-server closed'
                    buffer.extend(chunk); assert len(buffer) <= LIMIT
        raise TimeoutError(method)
    try:
        child = subprocess.Popen(cmd, env=env, cwd=workspace, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        report['pid'] = child.pid
        rpc('initialize', {'clientInfo': {'name': 'agentkib_readonly_codex', 'version': '0.13.0'},
                           'capabilities': {'experimentalApi': True}})
        send({'method': 'initialized', 'params': {}})
        for name, method, params in [
            ('readBefore', 'thread/read', {'threadId': sid, 'includeTurns': True}),
            ('resume', 'thread/resume', {'threadId': sid, 'cwd': str(workspace), 'approvalPolicy': 'never', 'sandbox': 'read-only'}),
            ('readAfter', 'thread/read', {'threadId': sid, 'includeTurns': True})]:
            response = rpc(method, params)
            assert native_messages(response, sid, workspace, target) == expected, 'Official full history mismatch'
            report[name] = True
        listing = rpc('thread/list', {'limit': 20, 'sourceKinds': ['exec'], 'modelProviders': []})
        assert 'error' not in listing and [x['id'] for x in listing['result']['data']] == [sid]
        report.update(listedExactlyOnce=True, passed=True, sourceKinds=['exec'], modelRequests=0)
    finally:
        if child:
            report.update(OWNED.cleanup(child))
            for stream in (child.stdin, child.stdout, child.stderr): stream.close()
        private_json(attempt / f'readback-{index}.json', {'report': report, 'rpc': log})
        (attempt / f'readback-{index}.stderr').write_bytes(err)
    assert report['ownedProcessGroupGone']
    return report


def audit_rollout(raw, original, sid, history, prompt, answer=None):
    assert raw.startswith(original), 'Full original JSONL prefix changed'
    rows = [strict_json(line) for line in raw.splitlines()]
    metas = [r['payload'] for r in rows if r['type'] == 'session_meta']
    assert metas and all(m['id'] == sid for m in metas)
    for row in rows:
        if row['type'] == 'response_item':
            assert row['payload']['type'] in ('message', 'reasoning'), 'Native tool/function replay'
        if row['type'] == 'event_msg':
            kind = row['payload']['type']
            assert not any(word in kind for word in ('exec_command', 'tool_call', 'patch_apply', 'mcp_tool'))
    if answer is not None:
        appended = [r['payload'] for r in rows[len(original.splitlines()):] if r['type'] == 'response_item']
        users = [m for m in appended if m.get('role') == 'user' and m.get('content') == [{'type': 'input_text', 'text': prompt}]]
        assistants = [m for m in appended if m.get('role') == 'assistant']
        assert len(users) == 1 and len(assistants) == 1
        assert assistants[0]['content'] == [{'type': 'output_text', 'text': answer}]
    return {'originalPrefixPreserved': True, 'sessionIdMatches': True, 'historyToolsNotReplayed': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('attempt', type=Path)
    parser.add_argument('--mode', choices=['mock', 'live'], default='mock')
    parser.add_argument('--public-case', type=Path, default=CASE)
    parser.add_argument('--profile', choices=PROFILES, default='0.146.1')
    parser.add_argument('--source-agent', choices=['grok-build', 'claude-code'], default='grok-build')
    args = parser.parse_args(); attempt = args.attempt.resolve(); live = args.mode == 'live'
    global BINARY, BINARY_SHA
    BINARY, BINARY_SHA = binary_profile(args.profile)
    case = args.public_case.resolve()
    assert attempt.is_relative_to(ROOT) or attempt.is_relative_to(BATCH)
    assert not attempt.exists()
    assert case == CASE or case.is_relative_to(BATCH)
    os.umask(0o077); attempt.mkdir(mode=0o700, parents=True, exist_ok=False)
    result = {'mode': args.mode, 'passed': False, 'realReplyPassed': False, 'model': MODEL,
              'targetVersion': args.profile, 'sourceAgent': args.source_agent,
              'realProviderRequests': 0 if not live else None}
    cancellation = Cancellation().install(); relay = None; target = None; original = None
    public_target = None; source_files = {}; public_baseline = None
    try:
        assert digest(BINARY.read_bytes()) == BINARY_SHA
        prior, public_target, sid, original, history, source_files, plan_hash = source_snapshot(case, args.source_agent)
        public_baseline = public_target.read_bytes()
        codex, home = case / 'codex', case / 'home'
        if not live:
            codex, home = attempt / 'codex', attempt / 'home'; codex.mkdir(); home.mkdir()
            target = codex / public_target.relative_to(case / 'codex')
            target.parent.mkdir(parents=True); target.write_bytes(original)
        else: target = public_target
        assert not (codex / 'auth.json').exists()
        assert list(codex.rglob('rollout-*.jsonl')) == [target]
        workspace = case / 'workspace'
        env = {'HOME': str(home), 'CODEX_HOME': str(codex), 'PATH': '/usr/bin:/bin',
               'LANG': 'en_US.UTF-8', 'TERM': 'dumb'}
        result.update(sessionId=sid, target=str(target), publicCase=str(case), binarySha256=BINARY_SHA,
                      originalSha256=digest(original), publicPlanSha256=plan_hash, fixtureSQLiteCopied=False)
        for name in ('deepseek-codex-native-once.py', 'deepseek_codex_guard.py', 'deepseek_once_relay.py', 'native-offline-tui.py', 'codex_qa_profiles.py'):
            data = (HERE / name).read_bytes(); (attempt / name).write_bytes(data)
            result[name + 'Sha256'] = digest(data)
        if live:
            assert os.environ.get('SSL_CERT_FILE') == str(CA) and digest(CA.read_bytes()) == CA_SHA
            context = ssl.create_default_context()
            assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname
            result['tls'] = {'caFile': str(CA), 'caSha256': CA_SHA, 'verifyRequired': True, 'checkHostname': True}
        snapshot = load_current_provider() if live else dataclasses.replace(
            synthetic_provider(), _credential=secrets.token_urlsafe(32))
        projection = make_projection(history, PROMPT, workspace, codex,
                                     datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat(), args.profile)
        contract = {'schemaVersion': 1, 'protocol': 'responses', 'model': MODEL, 'stream': True,
            'tools': POLICY, 'toolsSha256': TOOLS_SHA, 'sessionId': sid, 'providerFingerprint': snapshot.fingerprint,
            'history': history, 'prompt': PROMPT, 'projection': projection, 'startedAt': time.time(),
            'codexVersion': args.profile}
        private_json(attempt / 'contract.json', contract)
        cancellation.checkpoint()
        if live:
            private_json(case / '.deepseek-codex-live-consumed.json', {'sessionId': sid, 'attempt': str(attempt),
                'providerFingerprint': snapshot.fingerprint, 'planSha256': plan_hash})
        kwargs = {} if live else {'_connection_factory': synthetic_transport(synthetic_sse(prior['marker'] + '; ' + prior['decision']))}
        relay = CodexRelay(attempt / 'contract.json', snapshot, offline=not live, **kwargs).start()
        env['AGENTKIB_QA_LOOPBACK_KEY'] = relay.client_token
        cmd = command(flags(relay.base_url), relay.sandbox_profile, ['exec', 'resume', '--ignore-user-config',
            '--ignore-rules', '--skip-git-repo-check', '--json', '-m', MODEL, sid, '-'])
        result['command'] = cmd; result['provider'] = snapshot.safe_metadata()
        try: run_cli(cmd, env, workspace, PROMPT, cancellation, relay, result)
        finally:
            relay.close(); result['relay'] = relay.summary()
        cancellation.checkpoint()
        assert result['naturalExitCode'] == 0 and result['ownedProcessGroupGone']
        assert result['relay']['admitted'] == result['relay']['dispatchAttempts'] == 1
        assert result['relay']['responses'] == [200] and result['relay']['blocked'] == 0
        proof = strict_json((attempt / 'response-validation.json').read_bytes())
        answer = proof['answer']; assert prior['marker'] in answer and prior['decision'] in answer
        result.update(audit_cli_output(bytes(result['_buffers'][0]), sid, answer))
        result.update(audit_rollout(target.read_bytes(), original, sid, history, PROMPT, answer))
        expected = history + [{'role': 'user', 'text': PROMPT}, {'role': 'assistant', 'text': answer}]
        readonly_env = {k: v for k, v in env.items() if k != 'AGENTKIB_QA_LOOPBACK_KEY'}
        result['readbacks'] = [readback(readonly_env, workspace, sid, target, expected, attempt, n, cancellation) for n in (1, 2)]
        result.update(answer=answer, passed=True, realReplyPassed=live, syntheticMockReplyPassed=not live)
    except BaseException as exc:
        result['errorType'] = type(exc).__name__
        result['error'] = str(exc) if relay is None else relay.redact(str(exc).encode()).decode()
    finally:
        audit_errors = []
        def audit_step(name, action):
            try: action()
            except BaseException as exc: audit_errors.append({'step': name, 'errorType': type(exc).__name__})
        def close_relay():
            if relay:
                relay.close(); result['relay'] = relay.summary()
        def save_output():
            for name, data in zip(('stdout', 'stderr'), result.pop('_buffers', [])):
                (attempt / name).write_bytes(relay.redact(bytes(data)))
        def audit_target():
            if target and original:
                current = target.read_bytes()
                assert relay is None or relay.redact(current) == current
                (attempt / 'native-after.jsonl').write_bytes(current)
                result.update(audit_rollout(current, original, result['sessionId'], [], PROMPT))
                assert list(target.parents[4].rglob('rollout-*.jsonl')) == [target]
                assert not (target.parents[4] / 'auth.json').exists()
        def audit_source():
            assert all(digest(Path(path).read_bytes()) == sha for path, sha in source_files.items())
            result['sourceUnchanged'] = bool(source_files)
            if not live and public_target:
                assert public_target.read_bytes() == public_baseline
                result['originalPublicTargetUnchanged'] = True
        def audit_secrets():
            if relay:
                for scan_root in (attempt, Path(result['target']).parents[4]):
                    for path in scan_root.rglob('*'):
                        if path.is_file() and not path.is_symlink():
                            assert path.stat().st_size <= 128 * 1024 * 1024
                            assert relay.redact(path.read_bytes()) == path.read_bytes(), 'Credential reached disk'
        try:
            for name, action in [('relayCleanup', close_relay), ('output', save_output), ('target', audit_target),
                                 ('source', audit_source), ('secretScan', audit_secrets)]:
                audit_step(name, action)
        finally:
            if audit_errors:
                result['finalAuditErrors'] = audit_errors
                result['finalAuditErrorType'] = audit_errors[0]['errorType']
            result['signals'] = list(cancellation.signals)
            if cancellation.signals or result.get('errorType') or result.get('finalAuditErrorType'):
                result['passed'] = result['realReplyPassed'] = result['syntheticMockReplyPassed'] = False
            private_json(attempt / 'result.json', result)
            cancellation.restore()
    print(json.dumps({k: result.get(k) for k in ('passed', 'realReplyPassed', 'mode', 'relay', 'errorType', 'error', 'finalAuditErrorType')}))
    return 0 if result['passed'] else 1


if __name__ == '__main__': raise SystemExit(main())
