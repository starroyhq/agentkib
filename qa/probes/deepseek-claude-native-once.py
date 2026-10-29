"""New-provider Claude attempt, never reusing/deleting the old CPA failure.

prepare RUNTIME NEW_CASE NEW_PREPARATION_DIR
mock NEW_CASE EXISTING_PUBLIC_CASE
live EXISTING_PUBLIC_CASE NEW_ATTEMPT_DIR

Mock uses only a synthetic fixture/key and a loopback 500, no provider database.
Live must only be invoked after explicit supervisor review/authorization.
"""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import select
import shlex
import signal
import ssl
import subprocess
import sys
import time
import uuid

from deepseek_once_relay import (MODEL, digest, load_current_provider, private_json,
                                start_relay, synthetic_provider)

HERE = Path(__file__).resolve().parent
CLI = Path('/Users/user/.local/share/claude/versions/2.1.285')
CLI_SHA = '51f09bd1e021d9fa8a1864c179799bd37cb39962a937935c5cf6823398e86db4'
ROOT = Path('/Users/user/Documents/AgentKib-archives/2026-10-01/provider-retest/Claude')
TRUSTED_CA = Path('/Users/user/Library/Python/3.11/lib/python/site-packages/certifi/cacert.pem')
TRUSTED_CA_SHA = 'c55b21f907f7f86d48add093552fb5651749ff5f860508ccbb423d6c1fbd80c7'
PROMPT = 'What exact random marker and project storage decision did we agree in the imported history? Quote both, without using any tools.'
SPEC = importlib.util.spec_from_file_location('owned_native', HERE / 'native-offline-tui.py')
OWNED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OWNED)


def load_case(case):
    result = json.loads((case / 'result.json').read_text())
    plan = json.loads((case / 'plan.json').read_text())
    launch = plan['launch_request']
    target = Path(launch['target_path']).resolve()
    sid = launch['target_session_id']
    assert target.is_relative_to(case / 'claude/projects') and target.name == sid + '.jsonl'
    assert result['targetSessionId'] == sid and result['targetPath'] == str(target)
    assert result['first']['status'] == 'launched' and result['reopen']['target_agent'] == 'claude-code'
    original, = [row['after'].encode() for row in plan['change_set']['changes'] if row['target'] == str(target)]
    assert target.read_bytes() == original, 'Fresh public target changed before this attempt'
    rows = [json.loads(line) for line in original.decode().splitlines()]
    assert all(row['sessionId'] == sid for row in rows)
    assert all(row['type'] in ('user', 'assistant', 'last-prompt') for row in rows)
    assert all(part['type'] == 'text' for row in rows if row['type'] in ('user', 'assistant') for part in row['message']['content'])
    assert all(Path(row['cwd']).resolve() == case / 'workspace' for row in rows if 'cwd' in row)
    history = [{'role': row['message']['role'], 'text': part['text']}
               for row in rows if row['type'] in ('user', 'assistant') for part in row['message']['content']]
    assert len(history) == 3 and history[0]['role'] == 'user'
    assert history[1:] == [{'role': 'user', 'text': f'Remember marker {result["marker"]}; project decision: {result["decision"]}.'},
                          {'role': 'assistant', 'text': f'Confirmed {result["marker"]} and {result["decision"]}.'}]
    assert sorted((case / 'claude/projects').rglob('*.jsonl')) == [target]
    assert all(Path(path).resolve().is_relative_to(case) and digest(Path(path).read_bytes()) == sha
               for path, sha in result['sourceFiles'].items())
    return result, target, sid, original, history


def offline_launch(pid_file, args):
    config = Path(os.environ['CLAUDE_CONFIG_DIR']).resolve()
    assert config.is_relative_to(ROOT) and config.name == 'claude'
    env = {'HOME': str(config.parent / 'home'), 'CLAUDE_CONFIG_DIR': str(config),
           'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8', 'TERM': 'xterm-256color',
           'DISABLE_AUTOUPDATER': '1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
    if args == ['--version']:
        os.execve('/usr/bin/sandbox-exec', OWNED.SANDBOX + [str(CLI), '--version'], env)
    assert len(args) == 2 and args[0] == '--resume'
    uuid.UUID(args[1])
    assert digest(CLI.read_bytes()) == CLI_SHA
    command = OWNED.SANDBOX + [str(CLI), '--bare', '--safe-mode', '--setting-sources', '',
        '--settings', '{}', '--strict-mcp-config', '--tools', '', '--no-chrome', '--model', MODEL, *args]
    pid_file = Path(pid_file)
    with pid_file.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        assert not (pid_file.parent / 'launch-closed.json').exists(), 'Preparation launch window is closed'
        child = subprocess.Popen(command, env=env, start_new_session=True)
        with pid_file.open('a') as out:
            out.write(json.dumps({'pid': child.pid, 'uuid': args[1]}) + '\n')
            out.flush(); os.fsync(out.fileno())
    try:
        child.wait(timeout=90)
    finally:
        OWNED.cleanup(child)


def prepare(runtime, case, evidence):
    assert case.is_relative_to(ROOT) and evidence.is_relative_to(ROOT)
    assert not case.exists()
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    pid_file = evidence / 'native-pids.jsonl'
    wrapper = evidence / 'claude-offline-wrapper'
    words = [sys.executable, str(Path(__file__).resolve()), 'offline-launch', str(pid_file)]
    wrapper.write_text('#!/bin/sh\nexec ' + ' '.join(shlex.quote(word) for word in words) + ' "$@"\n')
    wrapper.chmod(0o700)
    command = [sys.executable, str(HERE / 'claude-public-import.py'), str(runtime), str(wrapper), str(case)]
    try:
        with (evidence / 'public-import.log').open('wb') as out:
            completed = subprocess.run(command, stdout=out, stderr=subprocess.STDOUT, timeout=150)
        assert completed.returncode == 0, 'Public import failed; preserve evidence'
    finally:
        # CLI children get fresh groups in offline_launch; never signal Terminal's
        # inherited shell group. These PIDs come exclusively from our wrapper.
        with pid_file.with_suffix('.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            private_json(evidence / 'launch-closed.json', {'closed': True})
            records = [json.loads(line) for line in pid_file.read_text().splitlines()] if pid_file.exists() else []
        for item in records:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                if OWNED.group_exists(item['pid']):
                    os.killpg(item['pid'], sig)
                    deadline = time.monotonic() + 3
                    while OWNED.group_exists(item['pid']) and time.monotonic() < deadline:
                        time.sleep(.05)
            item['processGroupGone'] = not OWNED.group_exists(item['pid'])
        private_json(evidence / 'native-cleanup.json', records)
        assert all(item['processGroupGone'] for item in records)
    load_case(case)
    private_json(evidence / 'prepared.json', {'publicCase': str(case), 'command': command,
        'runtimeSha256': digest(runtime.read_bytes()), 'cliSha256': CLI_SHA,
        'executorSha256': digest(Path(__file__).read_bytes()), 'modelRequests': 0})


def mock_case(case, fixture):
    case.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name in ('home', 'workspace', 'claude'):
        (case / name).mkdir(mode=0o700)
    plan = json.loads((fixture / 'plan.json').read_text())
    source_target = plan['launch_request']['target_path']
    payload, = [item['after'] for item in plan['change_set']['changes'] if item['target'] == source_target]
    rows = [json.loads(line) for line in payload.splitlines()]
    sid = str(uuid.uuid4())
    for row in rows:
        row['sessionId'] = sid
        if 'cwd' in row: row['cwd'] = str(case / 'workspace')
    target = case / 'claude/projects' / str(case / 'workspace').replace('/', '-') / (sid + '.jsonl')
    target.parent.mkdir(parents=True)
    target.write_text('\n'.join(json.dumps(row) for row in rows) + '\n')
    history = [{'role': row['message']['role'], 'text': part['text']}
               for row in rows if row['type'] in ('user', 'assistant') for part in row['message']['content']]
    return target, sid, target.read_bytes(), history


def scan_native_secrets(case, relay):
    scanned, found = 0, []
    roots = [case / name for name in ('home', 'claude', 'workspace')]
    for root in roots:
        for path in root.rglob('*'):
            if path.is_file() and not path.is_symlink():
                content = path.read_bytes()
                scanned += 1
                if relay.redact(content) != content:
                    found.append(str(path))
    return {'roots': [str(root) for root in roots], 'filesScanned': scanned, 'leakingFiles': found, 'passed': not found}


def tool_blocks(value):
    if isinstance(value, dict):
        return int(value.get('type') in ('tool_use', 'tool_result')) + sum(tool_blocks(v) for v in value.values())
    if isinstance(value, list):
        return sum(tool_blocks(item) for item in value)
    return 0


def validate_assistant_records(records, answer):
    """Thinking-only native records are not extra user-visible answers."""
    assert isinstance(answer, str) and answer
    thinking_only, texts = 0, []
    for row in records:
        assert row['type'] == row['message']['role'] == 'assistant'
        parts = row['message']['content']
        assert isinstance(parts, list) and parts
        assert all(part.get('type') in ('thinking', 'text') for part in parts), 'Unknown assistant block'
        assert all(isinstance(part.get('thinking' if part['type'] == 'thinking' else 'text'), str) for part in parts)
        text = ''.join(part['text'] for part in parts if part['type'] == 'text')
        if text:
            texts.append(text)
        else:
            assert all(part['type'] == 'thinking' for part in parts), 'Empty visible-text record is not thinking-only'
            thinking_only += 1
    assert texts == [answer], 'Complete native final answer differs from CLI output'
    return {'thinkingOnlyRecords': thinking_only, 'finalNonemptyTexts': texts,
            'completeFinalTextEqualsCliAnswer': True, 'unknownOrToolBlocks': 0}


def readonly_restart(case, target, sid, history, answer, evidence):
    spec = importlib.util.spec_from_file_location('claude_offline', HERE / 'claude-offline-tui.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    before = target.read_bytes()
    env = {'HOME': str(case / 'home'), 'CLAUDE_CONFIG_DIR': str(case / 'claude'),
           'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8', 'TERM': 'xterm-256color',
           'DISABLE_AUTOUPDATER': '1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
    command = OWNED.SANDBOX + [str(CLI), '--bare', '--safe-mode', '--setting-sources', '',
        '--settings', '{}', '--strict-mcp-config', '--tools', '', '--no-chrome', '--model', MODEL, '--resume', sid]
    imported = json.loads((case / 'result.json').read_text())
    displayed_answer = answer.replace('`' + imported['marker'] + '`', imported['marker']).replace(
        '`' + imported['decision'] + '`', imported['decision'])
    expected = [(message['role'], message['text']) for message in history] + [('user', PROMPT), ('assistant', displayed_answer)]
    result = module.run_tui(command, env, case / 'workspace', expected, evidence, 'readonly-restart')
    result['appendedMetadata'] = module.suffix_records(target.read_bytes(), before, sid)
    result['baselineSha256'] = digest(before)
    result['nativeAnswer'] = answer
    result['displayedAnswer'] = displayed_answer
    result['displayNormalization'] = 'Only inline-code delimiters around the exact imported marker and decision are rendered without backticks; native text is verified separately.'
    result['tuiHelperSha256'] = digest((HERE / 'claude-offline-tui.py').read_bytes())
    (evidence / 'tui-helper-source.py').write_bytes((HERE / 'claude-offline-tui.py').read_bytes())
    private_json(evidence / 'readonly-restart.json', result)
    assert result['passed'] and result['ownedProcessGroupGone'], 'Offline same-UUID readback incomplete'
    return result


def run(mode, case, destination):
    live = mode == 'live'
    assert case.is_relative_to(ROOT), 'Only the new provider test area is allowed'
    assert digest(CLI.read_bytes()) == CLI_SHA
    if live:
        result, target, sid, original, history = load_case(case)
        evidence = destination
        assert evidence.is_relative_to(ROOT)
        evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
        assert os.environ.get('SSL_CERT_FILE') == str(TRUSTED_CA), 'Explicit reviewed CA bundle is required'
        assert digest(TRUSTED_CA.read_bytes()) == TRUSTED_CA_SHA, 'Reviewed CA bundle changed'
        context = ssl.create_default_context()
        assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname
        tls_proof = {'caFile': str(TRUSTED_CA), 'caSha256': TRUSTED_CA_SHA,
                     'verifyMode': 'CERT_REQUIRED', 'checkHostname': True, 'upstreamHost': 'api.deepseek.com'}
        snapshot = load_current_provider()
    else:
        target, sid, original, history = mock_case(case, destination)
        evidence, result, snapshot = case, {}, synthetic_provider()
    private_json(evidence / 'native-started.json', {'mode': mode, 'sessionId': sid,
        'nativeCase': str(case), 'cliSha256': CLI_SHA, 'baselineSha256': digest(original)})
    # Live startup marker belongs to the native case as well: a different evidence
    # directory must not permit a second model attempt on the same case.
    private_json(case / 'deepseek-attempt-consumed.json', {'mode': mode, 'sessionId': sid, 'evidence': str(evidence)})
    contract = {'schemaVersion': 1, 'protocol': 'anthropic', 'model': MODEL, 'stream': True,
        'tools': 'none', 'sessionId': sid, 'providerFingerprint': snapshot.fingerprint,
        'history': history, 'prompt': PROMPT, 'claudeNoticeNewline': True}
    private_json(evidence / 'contract.json', contract)
    relay = start_relay(evidence / 'contract.json', snapshot, offline=not live)
    env = {'HOME': str(case / 'home'), 'CLAUDE_CONFIG_DIR': str(case / 'claude'),
        'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8', 'TERM': 'dumb',
        'ANTHROPIC_API_KEY': relay.client_token, 'ANTHROPIC_BASE_URL': relay.base_url,
        'CLAUDE_CODE_MAX_RETRIES': '0', 'CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES': '0',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_AUTOUPDATER': '1'}
    command = ['/usr/bin/sandbox-exec', '-p', relay.sandbox_profile, str(CLI), '--bare',
        '--safe-mode', '--setting-sources', '', '--settings', '{}', '--strict-mcp-config',
        '--tools', '', '--no-chrome', '--model', MODEL, '--permission-mode', 'dontAsk',
        '--max-turns', '1', '--max-budget-usd', '0.50', '--resume', sid,
        '--print', '--output-format', 'json']
    state = {'mode': mode, 'sessionId': sid, 'command': command, 'provider': snapshot.safe_metadata(),
        'cliSha256': CLI_SHA, 'executorSha256': digest(Path(__file__).read_bytes()),
        'relaySha256': digest((HERE / 'deepseek_once_relay.py').read_bytes()),
        'cleanupHelperSha256': digest((HERE / 'native-offline-tui.py').read_bytes()), 'passed': False}
    if live:
        state['tlsPreflight'] = tls_proof
    (evidence / 'executor-source.py').write_bytes(Path(__file__).read_bytes())
    (evidence / 'relay-source.py').write_bytes((HERE / 'deepseek_once_relay.py').read_bytes())
    (evidence / 'cleanup-helper-source.py').write_bytes((HERE / 'native-offline-tui.py').read_bytes())
    child = None
    buffers = [bytearray(), bytearray()]
    cancelled, handlers = [], {}
    def cancel(sig, _frame): cancelled.append(sig)
    try:
        for sig in OWNED.SIGNALS: handlers[sig] = signal.signal(sig, cancel)
        child = subprocess.Popen(command, env=env, cwd=case / 'workspace', stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        state['pid'] = child.pid
        child.stdin.write(PROMPT.encode()); child.stdin.close()
        streams = {child.stdout: buffers[0], child.stderr: buffers[1]}
        deadline = time.monotonic() + 180
        while streams and time.monotonic() < deadline:
            if cancelled or relay.summary()['blocked']:
                state['stoppedAfterCancellationOrRejectedRequest'] = True
                break
            ready, _, _ = select.select(list(streams), [], [], .1)
            for stream in ready:
                chunk = os.read(stream.fileno(), 65536)
                if not chunk:
                    del streams[stream]
                    continue
                streams[stream].extend(chunk)
                assert len(streams[stream]) <= 16 * 1024 * 1024, 'Native output limit'
        if child.poll() is None and not streams:
            child.wait(timeout=3)
        state['naturalExitCode'] = child.poll()
    except BaseException as exc:
        state['errorType'] = type(exc).__name__
    finally:
        try:
            relay.close()
        except BaseException as exc:
            state['relayCleanupErrorType'] = type(exc).__name__
        try:
            if child is not None:
                state.update(OWNED.cleanup(child))
                for stream in (child.stdout, child.stderr): stream.close()
            state['relay'] = relay.summary()
            state['signals'] = cancelled
            stdout, stderr = [relay.redact(bytes(buf)) for buf in buffers]
            (evidence / 'native.stdout').write_bytes(stdout)
            (evidence / 'native.stderr').write_bytes(stderr)
            current = target.read_bytes()
            state['originalHistoryPrefixPreserved'] = current.startswith(original)
            state['sourceUnchanged'] = all(digest(Path(path).read_bytes()) == sha for path, sha in result.get('sourceFiles', {}).items())
            state['nativeFiles'] = [str(path) for path in (case / 'claude/projects').rglob('*.jsonl')]
            rows = [json.loads(line) for line in current.decode().splitlines()]
            state['newPromptCount'] = sum(row.get('type') == 'user' and row.get('message', {}).get('content') == PROMPT for row in rows)
            state['targetSessionIds'] = sorted({row['sessionId'] for row in rows if 'sessionId' in row})
            state['scanNativeSecrets'] = scan_native_secrets(case, relay)
            suffix = current[len(original):] if current.startswith(original) else b''
            assert relay.redact(suffix) == suffix, 'Native suffix contains a secret'
            (evidence / 'native-history-suffix.jsonl').write_bytes(suffix)
            appended = [json.loads(line) for line in suffix.decode().splitlines()]
            assistants = [row for row in appended if row.get('type') == 'assistant']
            state['newAssistantTexts'] = [''.join(part['text'] for part in row['message']['content'] if part.get('type') == 'text') for row in assistants]
            state['nativeToolBlocks'] = tool_blocks(rows)
            try:
                response = json.loads(stdout)
                state.update(answer=response.get('result'), nativeSessionId=response.get('session_id'),
                    isError=response.get('is_error'), usage=response.get('usage'), numTurns=response.get('num_turns'))
            except (ValueError, UnicodeError):
                state['responseParseFailed'] = True
            if live and state.get('isError') is False:
                state['nativeAssistantAudit'] = validate_assistant_records(assistants, state.get('answer'))
            common = (not cancelled and not state.get('errorType') and not state.get('relayCleanupErrorType')
                      and state.get('ownedProcessGroupGone') and state['relay']['admitted'] == 1
                      and state['originalHistoryPrefixPreserved'] and state['sourceUnchanged']
                      and state['targetSessionIds'] == [sid] and state['nativeFiles'] == [str(target)]
                      and state['scanNativeSecrets']['passed'] and state['nativeToolBlocks'] == 0)
            if live:
                state['passed'] = bool(common and state.get('naturalExitCode') == 0
                    and state['relay']['dispatchAttempts'] == 1 and state['relay']['blocked'] == 0
                    and state['relay']['responses'] == [200]
                    and state.get('isError') is False and state.get('nativeSessionId') == sid
                    and state.get('numTurns') == 1 and state['newPromptCount'] == 1
                    and state.get('nativeAssistantAudit', {}).get('completeFinalTextEqualsCliAnswer') is True
                    and result['marker'] in (state.get('answer') or '') and result['decision'] in (state.get('answer') or ''))
                if state['passed']:
                    try:
                        state['readonlyRestart'] = readonly_restart(case, target, sid, history, state['answer'], evidence)
                        state['scanNativeSecretsAfterRestart'] = scan_native_secrets(case, relay)
                        assert state['scanNativeSecretsAfterRestart']['passed']
                        assert all(digest(Path(path).read_bytes()) == sha for path, sha in result['sourceFiles'].items())
                    except Exception as exc:
                        state.update(passed=False, readbackErrorType=type(exc).__name__)
            else:
                state['passed'] = bool(common and state['relay']['dispatchAttempts'] == 0
                                      and (evidence / 'reviewed-request.json').exists())
        except BaseException as exc:
            state.update(passed=False, finalizationErrorType=type(exc).__name__)
        finally:
            if cancelled:
                state['passed'] = False
            private_json(evidence / 'result.json', state)
            for sig, handler in handlers.items(): signal.signal(sig, handler)
    print(json.dumps({key: state.get(key) for key in ('mode', 'passed', 'naturalExitCode', 'relay', 'errorType')}, indent=2))
    return 0 if state['passed'] else 1


def main():
    os.umask(0o077)
    if len(sys.argv) >= 4 and sys.argv[1] == 'offline-launch':
        offline_launch(sys.argv[2], sys.argv[3:]); return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['prepare', 'mock', 'live'])
    parser.add_argument('paths', nargs='+', type=Path)
    args = parser.parse_args()
    paths = [path.resolve() for path in args.paths]
    if args.mode == 'prepare':
        assert len(paths) == 3
        prepare(*paths); return 0
    assert len(paths) == 2
    return run(args.mode, *paths)


if __name__ == '__main__':
    raise SystemExit(main())
