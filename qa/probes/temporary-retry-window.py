"""Supervised, reversible CC Switch/CPA retry window; no model requests itself.

Prepare/self-test only unless explicitly invoked as:
  python3 temporary-retry-window.py run PRIVATE_NEW_DIRECTORY -- COMMAND ...
  python3 temporary-retry-window.py restore PRIVATE_EXISTING_DIRECTORY

Uses existing PyYAML from the local QA environment, not a production dependency.
Only permitted retry fields are journalled; the complete private CPA config backup
is mode 0600 and must never be committed or printed. No credentials are exported.
"""
import datetime
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import time
import tempfile
import yaml

CPA = Path('/Users/user/proxy/CLIProxyAPI/config.yaml')
CC = Path('/Users/user/.cc-switch/cc-switch.db')
AUTH = Path('/Users/user/proxy/CLIProxyAPI/auths')
LOCK = Path('/Users/user/Documents/AgentKib-archives/2026-09-30/full-interop/.global-retry-window.lock')
FIELDS = {('routing', 'retry', 'request-retry'): 0,
          ('routing', 'retry', 'max-retry-credentials'): 1,
          ('requests', 'streaming', 'bootstrap-retries'): 0}
MISSING = {'absent': True}


def lookup(value, path):
    for part in path:
        if not isinstance(value, dict) or part not in value:
            return MISSING
        value = value[part]
    return value


def node_pair(mapping, key):
    if not isinstance(mapping, yaml.MappingNode) or mapping.flow_style:
        raise ValueError('Only block YAML mappings are supported')
    matches = [(k, v) for k, v in mapping.value if k.value == key]
    if len(matches) > 1:
        raise ValueError('Duplicate YAML field')
    return matches[0] if matches else None


def change_yaml(text, path, value):
    node = yaml.compose(text)
    for index, key in enumerate(path):
        pair = node_pair(node, key)
        if pair is None:
            if value == MISSING:
                return text
            # Insert only the missing branch; retain comments and other values.
            indent = node.value[0][0].start_mark.column if node.value else node.start_mark.column
            branch = value
            for name in reversed(path[index:]):
                branch = {name: branch}
            lines = yaml.safe_dump(branch, sort_keys=False).splitlines(keepends=True)
            added = ''.join(' ' * indent + line for line in lines)
            position = node.end_mark.index
            if position and text[position - 1] != '\n':
                added = '\n' + added
            return text[:position] + added + text[position:]
        k, v = pair
        if index < len(path) - 1:
            node = v
            continue
        if value == MISSING:
            start = text.rfind('\n', 0, k.start_mark.index) + 1
            end = v.end_mark.index
            if not isinstance(v, yaml.MappingNode):
                newline = text.find('\n', end)
                end = len(text) if newline < 0 else newline + 1
            return text[:start] + text[end:]
        if not isinstance(v, yaml.ScalarNode):
            raise ValueError('Retry value is not scalar')
        replacement = json.dumps(value)
        return text[:v.start_mark.index] + replacement + text[v.end_mark.index:]
    raise AssertionError('Empty path')


def save_json(path, data):
    descriptor, name = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
    temporary = Path(name)
    with os.fdopen(descriptor, 'w') as out:
        json.dump(data, out, indent=2)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, path)


def change_cpa(expected, desired, remove_empty_streaming=False):
    # Preserve inode for Docker's single-file bind mount. flock coordinates our
    # own invocations; it is not a cross-application atomic compare-and-swap.
    with CPA.open('r+', encoding='utf-8') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        original = stream.read()
        parsed = yaml.safe_load(original)
        for path, value in expected.items():
            if lookup(parsed, path) != value:
                raise RuntimeError('Retry field changed externally: ' + '.'.join(path))
        changed = original
        for path, value in desired.items():
            changed = change_yaml(changed, path, value)
        if remove_empty_streaming and lookup(yaml.safe_load(changed), ('requests', 'streaming')) in ({}, None):
            changed = change_yaml(changed, ('requests', 'streaming'), MISSING)
        parsed_changed = yaml.safe_load(changed)
        for path, value in desired.items():
            if lookup(parsed_changed, path) != value:
                raise RuntimeError('Retry YAML update failed validation')
        stream.seek(0)
        if stream.read() != original:
            raise RuntimeError('Config changed before write')
        stream.seek(0)
        stream.write(changed)
        stream.truncate()
        stream.flush()
        os.fsync(stream.fileno())


def cc_read():
    with sqlite3.connect(f'file:{CC}?mode=ro', uri=True) as db:
        row = db.execute("select value from settings where key='rectifier_config'").fetchone()
    return row[0] if row else None


def cc_set(original, restoring=False):
    with sqlite3.connect(CC, timeout=10) as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute("select value from settings where key='rectifier_config'").fetchone()
        raw = row[0] if row else None
        current = json.loads(raw) if raw else {}
        before = json.loads(original) if original else {}
        if restoring:
            if current.get('enabled', True) == before.get('enabled', True):
                return  # Already restored, or the opening write never occurred.
            if current.get('enabled', True) is not False:
                raise RuntimeError('CC Switch enabled field changed externally')
            if 'enabled' in before:
                current['enabled'] = before['enabled']
            else:
                current.pop('enabled', None)
            if not current and original is None:
                db.execute("delete from settings where key='rectifier_config'")
                return
        else:
            if raw != original:
                raise RuntimeError('CC Switch rectifier changed before opening')
            current['enabled'] = False
        db.execute("insert into settings(key,value) values('rectifier_config',?) on conflict(key) do update set value=excluded.value",
                   (json.dumps(current),))


def check_overrides():
    files = list(AUTH.glob('*.json'))
    if len(files) != 1:
        raise RuntimeError('Expected exactly one existing provider auth')
    auth = json.loads(files[0].read_text())
    if auth.get('type') != 'relay' or auth.get('disabled') is True:
        raise RuntimeError('Existing provider identity changed')
    for field in ('request_retry', 'request-retry'):
        if field in auth and auth[field] not in (0, None):
            raise RuntimeError('Provider retry override requires separate handling')
    def walk(value, path=()):
        if isinstance(value, dict):
            for key, item in value.items():
                child = path + (key,)
                if key in ('request_retry', 'request-retry') and child not in FIELDS and item not in (None, 0):
                    raise RuntimeError('Config provider retry override exists')
                walk(item, child)
        elif isinstance(value, list):
            for item in value:
                walk(item, path + ('entry',))
    config = yaml.safe_load(CPA.read_text())
    walk(config)
    for key in ('switch-project', 'switch-preview-model'):
        if config.get('quota-exceeded', {}).get(key, False) is not False:
            raise RuntimeError('Quota fallback must be disabled')
    with sqlite3.connect(f'file:{CC}?mode=ro', uri=True) as db:
        row = db.execute("select auto_failover_enabled from proxy_config where app_type='claude'").fetchone()
        if row is None or row[0] != 0:
            raise RuntimeError('CC Switch automatic failover must be disabled')


def container_values():
    # Read only in memory, output only permitted field values.
    raw = subprocess.check_output(['docker', 'exec', 'cli-proxy-api', 'cat', '/CLIProxyAPI/config.yaml'], timeout=10)
    data = yaml.safe_load(raw)
    return {path: lookup(data, path) for path in FIELDS}


def verify_reload(since, expected, required_changes):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if container_values() != expected:
            raise RuntimeError('Docker bind contents differ from retry fields')
        # Docker output is retained in memory only. Record just whitelisted retry
        # change/reload lines, never general logs that may contain private data.
        result = subprocess.run(['docker', 'logs', '--since', since, 'cli-proxy-api'], capture_output=True, text=True, timeout=10)
        selected = []
        for line in (result.stdout + result.stderr).splitlines():
            if 'config_reload.go:' not in line:
                continue
            changed = re.search(r'\b(request-retry|max-retry-credentials): (\d+) -> (\d+)', line)
            if changed:
                selected.append(f'{changed[1]}: {changed[2]} -> {changed[3]}')
            elif 'config successfully reloaded, triggering client reload' in line:
                selected.append('config successfully reloaded, triggering client reload')
        joined = '\n'.join(selected)
        if 'config successfully reloaded' in joined and all(change in joined for change in required_changes):
            return selected
        time.sleep(0.2)
    raise RuntimeError('Running CPA did not acknowledge field reload before deadline')


def safe_error(error):
    # Parser exceptions can embed private YAML source; never print those.
    return str(error) if isinstance(error, RuntimeError) else type(error).__name__


def restore(directory):
    journal_path = directory / 'journal.json'
    state = json.loads(journal_path.read_text())
    state['status'] = 'restoring'
    state.pop('expiresAt', None)
    save_json(journal_path, state)
    errors = []
    if state.get('ccAttempted'):
        try:
            cc_set(state['ccOriginal'], restoring=True)
            state['ccAttempted'] = False
        except Exception as error:
            errors.append(safe_error(error))
    if state.get('cpaAttempted'):
        try:
            desired = {tuple(key.split('.')): value for key, value in state['cpaOriginal'].items()}
            current = yaml.safe_load(CPA.read_text())
            actual = {path: lookup(current, path) for path in FIELDS}
            restore_fields = {}
            for path, value in desired.items():
                if actual[path] == value:
                    continue
                if actual[path] == FIELDS[path]:
                    restore_fields[path] = value
                else:
                    errors.append('Retry field changed externally: ' + '.'.join(path))
            if restore_fields:
                since = datetime.datetime.now(datetime.timezone.utc).isoformat()
                changes = [f'{key[-1]}: {actual[key]} -> {value}' for key, value in restore_fields.items()
                           if value != MISSING and key[0] == 'routing']
                expected_now = dict(actual)
                expected_now.update(restore_fields)
                state['restoreConfirmation'] = {'since': since, 'changes': changes,
                    'expected': {'.'.join(path): value for path, value in expected_now.items()}}
                save_json(journal_path, state)
                change_cpa({path: actual[path] for path in restore_fields}, restore_fields,
                           state['streamingOriginallyAbsent'])
            confirmation = state.get('restoreConfirmation')
            if confirmation is None:
                confirmation = {'since': state.get('cpaSince', datetime.datetime.now(datetime.timezone.utc).isoformat()),
                                'changes': [], 'expected': {'.'.join(path): value for path, value in actual.items()}}
            state['restoreReload'] = verify_reload(confirmation['since'],
                {tuple(path.split('.')): value for path, value in confirmation['expected'].items()}, confirmation['changes'])
            state['cpaAttempted'] = any(lookup(yaml.safe_load(CPA.read_text()), path) != value
                                        for path, value in desired.items())
        except Exception as error:
            errors.append(safe_error(error))
    state['status'] = 'restore-needs-attention' if errors else 'restored'
    state.pop('expiresAt', None)
    state['errors'] = errors
    save_json(journal_path, state)
    if errors:
        raise RuntimeError('; '.join(errors))


def run(directory, command):
    directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    check_overrides()
    raw = CPA.read_bytes()
    data = yaml.safe_load(raw)
    with (directory / 'cpa-config.private.yaml').open('xb') as out:
        os.chmod(out.name, 0o600)
        out.write(raw)
        out.flush()
        os.fsync(out.fileno())
    state = {'schemaVersion': 1, 'status': 'prepared', 'endpoint': 'http://127.0.0.1:8317',
             'model': 'relay/claude-opus-5-5', 'configSha256': hashlib.sha256(raw).hexdigest(),
             'ccOriginal': cc_read(),
             'cpaOriginal': {'.'.join(path): lookup(data, path) for path in FIELDS},
             'streamingOriginallyAbsent': lookup(data, ('requests', 'streaming')) == MISSING,
             'ccAttempted': False, 'cpaAttempted': False}
    journal = directory / 'journal.json'
    save_json(journal, state)
    child = None
    def interrupted(signum, frame):
        raise InterruptedError('Window supervisor interrupted')
    previous_signals = {signum: signal.getsignal(signum) for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    for signum in previous_signals:
        signal.signal(signum, interrupted)
    try:
        state['ccAttempted'] = True
        save_json(journal, state)
        cc_set(state['ccOriginal'])
        if json.loads(cc_read()).get('enabled') is not False:
            raise RuntimeError('CC Switch effective setting mismatch')
        state['cpaAttempted'] = True
        since = datetime.datetime.now(datetime.timezone.utc).isoformat()
        state['cpaSince'] = since
        save_json(journal, state)
        previous = {path: lookup(data, path) for path in FIELDS}
        change_cpa(previous, FIELDS)
        changes = [f'{key[-1]}: {previous[key]} -> {value}' for key, value in FIELDS.items()
                   if previous[key] != value and key[0] == 'routing']
        state['openReload'] = verify_reload(since, FIELDS, changes)
        check_overrides()
        state['status'] = 'open'
        state['expiresAt'] = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=30)).isoformat()
        state['retryPolicy'] = {'requestRetry': 0, 'maxRetryCredentials': 1, 'streamBootstrapRetries': 0,
                                'credentialOverrides': False, 'ccSwitchRectifierEnabled': False,
                                'ccSwitchAutoFailoverEnabled': False, 'quotaSwitchProject': False,
                                'quotaSwitchPreviewModel': False}
        save_json(journal, state)
        child_env = os.environ.copy()
        child_env['AGENTKIB_RETRY_WINDOW'] = str(journal)
        child = subprocess.Popen(command, env=child_env, start_new_session=True)
        code = child.wait(timeout=1800)
        state['childExitCode'] = code
        save_json(journal, state)
        if code:
            raise RuntimeError('Supervised acceptance command failed')
    finally:
        for signum in previous_signals:
            signal.signal(signum, signal.SIG_IGN)
        try:
            if child is not None and child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
                except ProcessLookupError:
                    pass  # The supervised group exited between poll and kill.
        finally:
            try:
                restore(directory)
            finally:
                for signum, handler in previous_signals.items():
                    signal.signal(signum, handler)
    print(json.dumps({'status': 'restored', 'journal': str(journal)}))


if __name__ == '__main__':
    valid_run = len(sys.argv) >= 5 and sys.argv[1] == 'run' and sys.argv[3] == '--'
    valid_restore = len(sys.argv) == 3 and sys.argv[1] == 'restore'
    if not (valid_run or valid_restore):
        raise SystemExit(__doc__)
    directory = Path(sys.argv[2]).resolve()
    lock = os.open(LOCK, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if valid_run:
            run(directory, sys.argv[4:])
        else:
            restore(directory)
    except Exception as error:
        print(json.dumps({'error': safe_error(error), 'journal': str(directory / 'journal.json')}))
        raise SystemExit(1)
    finally:
        os.close(lock)
