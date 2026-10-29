#!/usr/bin/env python3
"""Real registered Cursor IDE source -> isolated Claude native file, offline.

Default is inspect (read-only). prepare creates a NEW case and uses the frozen
production Runtime for public source read/preview/plan; it does not apply or
launch a terminal. apply requires --reviewed-changeset, consumes one durable
attempt, applies that exact public ChangeSet, then resumes the pinned official
Claude twice in supervised network-denied PTYs. No prompts/credentials/tools.
The previous Cursor harness MUST be stopped before prepare or apply.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
SOURCE_EVIDENCE = Path('/Users/user/Documents/AgentKib-archives/2026-10-01/interop-closeout/cursor-native')
DEFAULT_CASE = SOURCE_EVIDENCE / 'reverse-claude'
CLI = Path('/Users/user/.local/share/claude/versions/2.1.285')
CLI_SHA = '51f09bd1e021d9fa8a1864c179799bd37cb39962a937935c5cf6823398e86db4'
HARNESS_SHA = '7e0d9a54a2fcd51534786d115031cca47a18d0a5faa712ff1a587b8622b641b9'
SANDBOX_PROFILE = '(version 1)(allow default)(deny network*)'
RPC_METHODS = {'sessions.sourceCapability', 'session.events', 'sessions.prepareHandoff',
               'sessions.planHandoff', 'changes.apply'}
SOURCE_FIELDS = ('workspace', 'workspace_id', 'source', 'source_sha256', 'native_source_session_id',
                 'native_id', 'native_plan', 'events', 'snapshot')
GRAPH_FIELDS = ('db_path', 'native_id', 'ids', 'marker_count', 'root_sha256', 'root_bytes',
                'blobs', 'full_payload_exact', 'sqlite_read_only', 'app_identity')
SOURCE_B = {'workspace_id': '40c90e90-5f36-496f-94f8-75f1e6e159b4',
            'native_id': '3e172a62-6cd8-4bff-818a-34f185c4d871',
            'native_source_session_id': '73e12ebf6c2b0abc30ac7943f7f04940543fe6ae3dd2f7c1642ff17a7ff1a480'}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    path = Path(value).absolute()
    require(not any(p.is_symlink() for p in (path, *path.parents)), 'Acceptance paths cannot be links')
    return path.resolve()


def read_json(path):
    path = canonical(path)
    require(path.is_file() and path.stat().st_size <= 16 * 1024 * 1024, 'Missing or oversized JSON evidence')
    return json.loads(path.read_text())


def save(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def load_module(path, expected=None):
    require(expected is None or digest(path.read_bytes()) == expected, 'QA helper identity changed')
    spec = importlib.util.spec_from_file_location('cursor_claude_' + uuid.uuid4().hex, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ensure_previous_stopped(source_manifest):
    require(not Path(source_manifest['control_socket']).exists(), 'Stop the previous Cursor harness first')
    snapshot = subprocess.run(['/bin/ps', '-axo', 'pid=,args='], capture_output=True, text=True,
                              timeout=3, check=True, env={'PATH': '/usr/bin:/bin'})
    executable = source_manifest['runtime']
    for line in snapshot.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2 or int(fields[0]) == os.getpid():
            continue
        # Match the executable token, not a parent's shell command or grep text.
        command = fields[1].split(None, 1)[0]
        require(command != executable, 'A Runtime using the original Cursor store is still alive')


def source_file_hashes(manifest):
    observed = {path: digest(canonical(path).read_bytes()) for path in manifest['source_file_hashes']}
    require(observed == manifest['source_file_hashes'], 'Original synthetic source bytes changed')
    return observed


class PublicRuntime:
    def __init__(self, case, manifest, helper):
        self.case, self.manifest, self.helper = case, manifest, helper
        native_manifest = {**manifest['source_manifest'], 'env': manifest['environment'],
                           'evidence': str(case), 'cases': {'a': {'workspace': manifest['source']['workspace']}}}
        self.native = helper.Runtime(native_manifest, self.log)

    def log(self, value):
        # The allowed RPC methods never request tickets or bridge credentials.
        with (self.case / 'rpc.jsonl').open('a') as output:
            output.write(json.dumps({'time_ns': time.time_ns(), **self.helper.safe(value)}, ensure_ascii=False) + '\n')

    def start(self):
        ensure_previous_stopped(self.manifest['source_manifest'])
        return self.native.start()

    def rpc(self, method, params):
        require(method in RPC_METHODS, 'This runner cannot launch terminals, pair a bridge, or submit a model prompt')
        return self.native.rpc(method, params)

    def stop(self):
        self.native.stop()


def source_snapshot(manifest, helper, rpc):
    source = manifest['source']
    source_file_hashes(manifest)
    graph = helper.database_snapshot(manifest['source_manifest'], source, source['native_plan'], source['native_id'])
    stable = {key: graph[key] for key in GRAPH_FIELDS}
    require(stable == {key: source['snapshot'][key] for key in GRAPH_FIELDS}, 'Cursor native identity/root/blobs changed')
    capability = rpc('sessions.sourceCapability', {'sessionId': source['native_source_session_id']})
    require(capability.get('status') == 'supported' and capability.get('source_surface') == 'cursor-ide', 'Source is not the actual registered Cursor IDE conversation')
    events = rpc('session.events', {'sessionId': source['native_source_session_id'], 'limit': 100})
    require(events == source['events'] and not events['warnings'] and events['next_cursor'] is None,
            'Complete native source role/body changed')
    require(all(event['kind'] in ('user-message', 'agent-message') and not event['truncated'] for event in events['events']), 'Source has unsupported history')
    preview = rpc('sessions.prepareHandoff', {'request': {'session_id': source['native_source_session_id'],
                  'target_agent': 'claude-code', 'format': 'markdown', 'history_budget_tokens': 64000}})
    draft = preview['draft']
    fingerprint = draft['source_fingerprint']
    require(isinstance(fingerprint, str) and len(fingerprint) == 64 and
            all(char in '0123456789abcdef' for char in fingerprint), 'Invalid public source fingerprint')
    require(draft['stats']['message_count'] == 5 and draft['stats']['turn_count'] == 5 and
            draft['stats']['tool_call_count'] == draft['stats']['tool_result_count'] ==
            draft['stats']['attachment_count'] == 0 and not draft['losses'] and
            draft['redaction_count'] == 0, 'Public source preview is incomplete or altered')
    return {'graph': stable, 'events': events, 'source_capability': capability,
            'public_source_fingerprint': fingerprint,
            'synthetic_source_hashes': source_file_hashes(manifest), 'Cursor_database_read_only': True}


def validate_plan(case, manifest, plan):
    launch = plan['launch_request']
    require(launch['mode'] == 'native-session' and launch['target_agent'] == 'claude-code', 'Public plan is not a Claude native file import')
    require(launch['workspace_id'] == manifest['source']['workspace_id'], 'Plan workspace changed')
    sid = launch['target_session_id']
    require(str(uuid.UUID(sid)) == sid, 'Target must have one canonical native UUID')
    target = canonical(launch['target_path'])
    require(target.is_relative_to(case / 'claude/projects') and target.name == sid + '.jsonl', 'Target escapes the independent Claude home')
    require(not Path(manifest['source_manifest']['fixture']).is_relative_to(case) and
            not target.is_relative_to(Path(manifest['source_manifest']['fixture'])), 'Target overlaps the old fixture')
    changes = plan['change_set']['changes']
    require(len(changes) == 1 and plan['change_set']['requires_home_approval'], 'Expected exactly one reviewed Agent Home change')
    change = changes[0]
    require(change['target'] == str(target) and change['scope'] == 'agent-home' and
            change['validator'] == 'jsonl' and change['original_hash'] is None and change['before'] == '', 'Unexpected native file change contract')
    require(plan['change_set']['project_root'] == manifest['source']['workspace'] and not launch.get('archive_id'), 'Unexpected workspace/archive write')
    require(len(change['after'].encode()) <= 2 * 1024 * 1024, 'Native payload exceeds QA bound')
    rows = [json.loads(line) for line in change['after'].splitlines()]
    require(rows and all(row.get('sessionId') == sid and row.get('type') in ('user', 'assistant', 'last-prompt') for row in rows), 'Unexpected native rows or session identity')
    messages, parent = [], None
    for row in rows[:-1]:
        require(row['type'] in ('user', 'assistant') and row['message']['role'] == row['type'] and
                row['parentUuid'] == parent and row['cwd'] == manifest['source']['workspace'], 'Native role/parent/workspace mismatch')
        require(all(part.get('type') == 'text' and isinstance(part.get('text'), str) for part in row['message']['content']), 'Executable historical tools/attachments are forbidden')
        messages.append((row['type'], '\n'.join(part['text'] for part in row['message']['content'])))
        parent = row['uuid']
    require(rows[-1] == {'type': 'last-prompt', 'lastPrompt': '', 'leafUuid': parent, 'sessionId': sid}, 'Native leaf/prompt must be empty and exact')
    source_messages = [('user' if event['kind'] == 'user-message' else 'assistant', event['content']) for event in manifest['source']['events']['events']]
    require(len(source_messages) == 5 and messages[1:] == source_messages, 'Native target omitted or reordered full Cursor history')
    require(messages[0] == source_messages[0] and len(messages) == 6, 'Expected a new import notice plus all five source records')
    return target, sid, change['after'].encode(), messages


def validate_reviewed(plan, reviewed):
    require(reviewed == plan['change_set'], 'Reviewed ChangeSet differs from the prepared public plan')


def prepare(args):
    case = canonical(args.case)
    require(not case.exists(), 'Reverse case must be new; do not overwrite existing evidence')
    require(case.parent == canonical(SOURCE_EVIDENCE) and case.name.startswith('reverse-claude'),
            'New target/evidence must remain in the dedicated reverse-Claude archive namespace')
    source_manifest = read_json(SOURCE_EVIDENCE / 'manifest.json')
    ensure_previous_stopped(source_manifest)
    state = read_json(SOURCE_EVIDENCE / 'state.json')
    selected = state['cases'][args.source]
    require(args.source == 'b' and all(selected.get(key) == value for key, value in SOURCE_B.items()),
            'Reverse acceptance is pinned to the unchanged workspace-b native source')
    require(all(key in selected for key in SOURCE_FIELDS), 'Current source must have passed the original full native readback')
    require(digest(CLI.read_bytes()) == CLI_SHA, 'Pinned official Claude 2.1.285 binary changed')
    require(digest((HERE / 'cursor-bridge-native-acceptance.py').read_bytes()) == HARNESS_SHA, 'Reviewed Cursor snapshot helper changed')
    case.mkdir(parents=True, mode=0o700)
    for directory in ('tools', 'bin', 'home', 'claude/projects', 'codex', 'grok', 'cursor-cli', 'hermes', 'openclaw', 'xdg-data', 'xdg-config', 'xdg-state', 'xdg-cache'):
        (case / directory).mkdir(parents=True, mode=0o700, exist_ok=True)
    tool_hashes = {}
    for name in ('claude-offline-tui.py', 'native-offline-tui.py', 'cursor-bridge-native-acceptance.py'):
        destination = case / 'tools' / name
        shutil.copyfile(HERE / name, destination)
        tool_hashes[name] = digest(destination.read_bytes())
        require(tool_hashes[name] == digest((HERE / name).read_bytes()), 'Helper changed while freezing')
    shutil.copyfile(Path(__file__), case / 'tools/runner-source.py')
    tool_hashes['runner-source.py'] = digest((case / 'tools/runner-source.py').read_bytes())
    shutil.copyfile(CLI, case / 'tools/claude')
    (case / 'tools/claude').chmod(0o700)
    require(digest((case / 'tools/claude').read_bytes()) == CLI_SHA == digest(CLI.read_bytes()), 'CLI changed while freezing')
    # Runtime version probes also inherit OS network denial, even though the
    # production Runtime itself needs its mandatory local MCP listener.
    wrapper = '#!/bin/sh\nexec /usr/bin/sandbox-exec -p ' + shlex.quote(SANDBOX_PROFILE) + ' ' + shlex.quote(str(case / 'tools/claude')) + ' "$@"\n'
    (case / 'bin/claude').write_text(wrapper)
    (case / 'bin/claude').chmod(0o700)
    env = {'HOME': str(case / 'home'), 'CLAUDE_CONFIG_DIR': str(case / 'claude'), 'PATH': str(case / 'bin'),
           'CODEX_HOME': str(case / 'codex'), 'GROK_HOME': str(case / 'grok'), 'CURSOR_CONFIG_DIR': str(case / 'cursor-cli'),
           'HERMES_HOME': str(case / 'hermes'), 'OPENCLAW_STATE_DIR': str(case / 'openclaw'),
           'OPENCLAW_CONFIG_PATH': str(case / 'openclaw/openclaw.json'),
           'AGENTKIB_BENCHMARK_DATA_DIR': source_manifest['env']['AGENTKIB_BENCHMARK_DATA_DIR'],
           'LANG': 'en_US.UTF-8', 'DISABLE_AUTOUPDATER': '1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
    for key in ('DATA', 'CONFIG', 'STATE', 'CACHE'):
        env[f'XDG_{key}_HOME'] = str(case / ('xdg-' + key.lower()))
    manifest = {'source_manifest': source_manifest, 'source_label': args.source,
                'source': {key: selected[key] for key in SOURCE_FIELDS}, 'environment': env,
                'source_file_hashes': {item['source']: item['source_sha256'] for item in state['cases'].values()},
                'claude_version': '2.1.285', 'claude_sha256': CLI_SHA, 'helpers': tool_hashes,
                'version_probe_wrapper_sha256': digest((case / 'bin/claude').read_bytes()),
                'runner_sha256': digest(Path(__file__).read_bytes()), 'runtime_sha256': source_manifest['runtime_sha256'],
                'no_credentials_copied': True, 'Cursor_visible_GUI_acceptance': 'not implied by source readback',
                'model_requests': 0, 'user_terminal_launches': 0}
    save(case / 'manifest.json', manifest)
    helper = load_module(case / 'tools/cursor-bridge-native-acceptance.py', HARNESS_SHA)
    runtime = PublicRuntime(case, manifest, helper)
    try:
        runtime.start()
        before = source_snapshot(manifest, helper, runtime.rpc)
        preview = runtime.rpc('sessions.prepareHandoff', {'request': {'session_id': selected['native_source_session_id'],
                              'target_agent': 'claude-code', 'format': 'markdown', 'history_budget_tokens': 64000}})
        draft = preview['draft']
        require(draft['source_fingerprint'] == before['public_source_fingerprint'], 'Source fingerprint changed before plan')
        require(draft['mode'] == 'native-session', 'Pinned official Claude native-file capability unavailable')
        plan = runtime.rpc('sessions.planHandoff', {'sessionId': selected['native_source_session_id'], 'workspaceId': selected['workspace_id'],
                           'targetAgent': 'claude-code', 'filename': draft['filename'], 'format': 'markdown', 'mode': draft['mode'],
                           'sourceFingerprint': draft['source_fingerprint'], 'targetFingerprint': draft.get('target_fingerprint'),
                           'acceptLosses': True, 'historyBudgetTokens': 64000, 'archiveId': draft.get('archive_id')})
        target, sid, payload, messages = validate_plan(case, manifest, plan)
        require(not target.exists() and not list((case / 'claude/projects').rglob('*.jsonl')), 'Target must be absent before apply')
        after = source_snapshot(manifest, helper, runtime.rpc)
        require(before == after, 'Source changed during prepare')
        save(case / 'preview.json', preview)
        save(case / 'file-plan.json', plan)
        save(case / 'changes-for-review.json', plan['change_set'])
        save(case / 'preparation.json', {'prepared': True, 'applied': False, 'source_before': before, 'source_after': after,
             'target_path': str(target), 'target_session_id': sid, 'payload_sha256': digest(payload), 'messages': messages,
             'manifest_sha256': digest((case / 'manifest.json').read_bytes()),
             'file_plan_sha256': digest((case / 'file-plan.json').read_bytes()),
             'review_file': str(case / 'changes-for-review.json'), 'model_requests': 0, 'user_terminal_launches': 0})
    except Exception as error:
        save(case / 'preparation-failure.json', {'error': str(error), 'no_automatic_retry': True})
        raise
    finally:
        runtime.stop()
    inspect(args)


def verify_target(case, target, sid, payload, baseline, offline):
    require(canonical(target) == target and target.is_file() and target.stat().st_size <= len(payload) + 128 * 1024,
            'Native target missing, unsafe, or oversized')
    current = target.read_bytes()
    require(current.startswith(payload) and current.startswith(baseline), 'Native target history prefix changed')
    suffix = offline.suffix_records(current, baseline, sid)
    files = sorted(str(path.resolve()) for path in (case / 'claude/projects').rglob('*.jsonl'))
    require(files == [str(target)], 'Native Claude UUID/file count changed')
    return {'target_session_id': sid, 'target_file_count': 1, 'target_sha256': digest(current),
            'reviewed_payload_sha256': digest(payload), 'complete_baseline_prefix_preserved': True,
            'no_new_user_assistant_or_tool_records': True, 'extra_JSONL_records': suffix}


def apply(args):
    case = canonical(args.case)
    manifest, plan = read_json(case / 'manifest.json'), read_json(case / 'file-plan.json')
    prepared = read_json(case / 'preparation.json')
    require(prepared['manifest_sha256'] == digest((case / 'manifest.json').read_bytes()) and
            prepared['file_plan_sha256'] == digest((case / 'file-plan.json').read_bytes()),
            'Prepared public manifest/plan bytes changed')
    require(digest(Path(__file__).read_bytes()) == manifest['runner_sha256'], 'Prepared runner changed; do not reinterpret an existing operation')
    ensure_previous_stopped(manifest['source_manifest'])
    reviewed = canonical(args.reviewed_changeset)
    validate_reviewed(plan, read_json(reviewed))
    require(not (case / 'apply-attempt.json').exists() and not (case / 'result.json').exists(), 'This operation was already attempted; no automatic or manual redispatch')
    for name, value in manifest['helpers'].items():
        require(digest((case / 'tools' / name).read_bytes()) == value, 'Frozen helper changed')
    require(digest((case / 'tools/claude').read_bytes()) == CLI_SHA, 'Frozen native CLI changed')
    require(digest((case / 'bin/claude').read_bytes()) == manifest['version_probe_wrapper_sha256'], 'Network-denying version probe wrapper changed')
    target, sid, payload, messages = validate_plan(case, manifest, plan)
    require(not target.exists() and not list((case / 'claude/projects').rglob('*.jsonl')), 'Target already exists; no overwrite/re-import')
    helper = load_module(case / 'tools/cursor-bridge-native-acceptance.py', HARNESS_SHA)
    offline = load_module(case / 'tools/claude-offline-tui.py', manifest['helpers']['claude-offline-tui.py'])
    runtime = PublicRuntime(case, manifest, helper)
    result = {'passed': False, 'source_agent': 'cursor', 'source_surface': 'cursor-ide', 'target_agent': 'claude-code',
              'target_session_id': sid, 'target_path': str(target), 'model_requests': 0, 'user_terminal_launches': 0,
              'Cursor_visible_GUI_verified': False, 'Cursor_live_reply_verified': False, 'runs': []}
    attempted = False
    try:
        runtime.start()
        result['source_before'] = source_snapshot(manifest, helper, runtime.rpc)
        require(result['source_before'] == prepared['source_before'], 'Prepared source fingerprint/history changed before apply')
        # Durable exclusive receipt is written before the only production apply.
        save(case / 'apply-attempt.json', {'time_ns': time.time_ns(), 'change_set_id': plan['change_set']['id'],
             'reviewed_file': str(reviewed), 'reviewed_file_sha256': digest(reviewed.read_bytes()),
             'payload_sha256': digest(payload), 'target_session_id': sid})
        attempted = True
        result['apply_report'] = runtime.rpc('changes.apply', {'changeSet': plan['change_set'], 'approveHome': True})
        require(target.read_bytes() == payload, 'Applied bytes differ from the reviewed public ChangeSet')
        baseline = payload
        result['native_file_import_verified'] = True
        env = {'HOME': str(case / 'home'), 'CLAUDE_CONFIG_DIR': str(case / 'claude'), 'PATH': '/usr/bin:/bin',
               'LANG': 'en_US.UTF-8', 'TERM': 'xterm-256color', 'DISABLE_AUTOUPDATER': '1',
               'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
        command = offline.OWNED.SANDBOX + [str(case / 'tools/claude'), '--bare', '--safe-mode', '--setting-sources', '',
                  '--settings', '{}', '--strict-mcp-config', '--tools', '', '--no-chrome', '--resume', sid]
        result.update(binary_sha256=CLI_SHA, runtime_sha256=manifest['runtime_sha256'], environment=env,
                      complete_reviewed_target_messages=messages, all_native_children_OS_network_denied=True)
        result['target_before'] = verify_target(case, target, sid, payload, baseline, offline)
        for number in (1, 2):
            run = offline.run_tui(command, env, Path(manifest['source']['workspace']), messages, case, number)
            result['runs'].append(run)
            run['target_after'] = verify_target(case, target, sid, payload, baseline, offline)
            run['source_after'] = source_snapshot(manifest, helper, runtime.rpc)
            require(run['source_after'] == result['source_before'], 'Cursor native source changed during offline resume')
            save(case / f'run-{number}-integrity.json', {'target': run['target_after'], 'source': run['source_after']})
            require(run.get('ownedProcessGroupGone') and run.get('passed'), 'Native history UI not verified; no login/model prompt/retry permitted')
        result['source_after'] = source_snapshot(manifest, helper, runtime.rpc)
        require(result['source_after'] == result['source_before'], 'Cursor native source changed')
        result['target_after'] = verify_target(case, target, sid, payload, baseline, offline)
        result.update(passed=True, native_resume_twice_verified=True)
    except Exception as error:
        result.update(error=str(error), no_automatic_retry=True, operation_outcome='attempted-preserved' if attempted else 'not-applied')
        raise
    finally:
        try:
            runtime.stop()
        finally:
            save(case / 'result.json', result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


def inspect(args):
    case = canonical(args.case)
    require(case.is_dir(), 'No prepared reverse case; explicitly run prepare first')
    manifest, plan = read_json(case / 'manifest.json'), read_json(case / 'file-plan.json')
    target, sid, payload, messages = validate_plan(case, manifest, plan)
    print(json.dumps({'case': str(case), 'mode': 'inspect-only', 'source_session_id': manifest['source']['native_source_session_id'],
          'source_native_id': manifest['source']['native_id'], 'target_path': str(target), 'target_session_id': sid,
          'change_set_file': str(case / 'changes-for-review.json'), 'payload_sha256': digest(payload),
          'complete_target_role_body': messages, 'apply_attempt_exists': (case / 'apply-attempt.json').exists(),
          'target_exists': target.exists(), 'Claude_binary_sha256': manifest['claude_sha256'],
          'Runtime_sha256': manifest['runtime_sha256'], 'Cursor_visible_GUI_acceptance': 'separate and pending',
          'no_apply_or_launch_in_inspect': True}, ensure_ascii=False, indent=2))


def selftest(_):
    plan = {'change_set': {'id': 'one-operation', 'changes': [{'target': '/synthetic/owned/target', 'after': 'complete history'}]}}
    validate_reviewed(plan, json.loads(json.dumps(plan['change_set'])))
    for reviewed in ({'id': 'other', 'changes': plan['change_set']['changes']},
                     {'id': 'one-operation', 'changes': []}, {'id': 'one-operation', 'changes': plan['change_set']['changes'], 'unknown': True}):
        try:
            validate_reviewed(plan, reviewed)
        except RuntimeError:
            continue
        raise RuntimeError('Modified/unreviewed ChangeSet accepted')
    require('sessions.continueHandoff' not in RPC_METHODS and 'sessions.launchHandoff' not in RPC_METHODS and
            'cursor.bridge' not in RPC_METHODS and 'agents.run' not in RPC_METHODS, 'Unsafe RPC admitted')
    case, sid = Path('/synthetic/qa/reverse-claude'), '00000000-0000-0000-0000-000000000001'
    source = [('user', 'Untrusted imported history'), ('user', '完整 UTF-8\n第二行'),
              ('assistant', '完整回答\n保留换行'), ('user', 'Literal `SELECT 1;`'), ('assistant', '已记录；没有执行。')]
    workspace = '/synthetic/workspace-b'
    fixture = {'source': {'workspace_id': 'workspace-b', 'workspace': workspace,
                          'events': {'events': [{'kind': 'user-message' if role == 'user' else 'agent-message', 'content': body}
                                               for role, body in source]}},
               'source_manifest': {'fixture': '/synthetic/old-fixture'}}
    rows, parent = [], None
    for number, (role, body) in enumerate([source[0], *source], 2):
        native_uuid = str(uuid.UUID(int=number))
        rows.append({'type': role, 'sessionId': sid, 'uuid': native_uuid, 'parentUuid': parent,
                     'cwd': workspace, 'message': {'role': role, 'content': [{'type': 'text', 'text': body}]}})
        parent = native_uuid
    rows.append({'type': 'last-prompt', 'lastPrompt': '', 'leafUuid': parent, 'sessionId': sid})
    payload = '\n'.join(json.dumps(row, ensure_ascii=False) for row in rows) + '\n'
    native_plan = {'launch_request': {'mode': 'native-session', 'target_agent': 'claude-code',
                   'workspace_id': 'workspace-b', 'target_session_id': sid,
                   'target_path': str(case / 'claude/projects/project' / (sid + '.jsonl'))},
                   'change_set': {'requires_home_approval': True, 'project_root': workspace,
                                  'changes': [{'target': str(case / 'claude/projects/project' / (sid + '.jsonl')),
                                               'scope': 'agent-home', 'validator': 'jsonl', 'original_hash': None,
                                               'before': '', 'after': payload}]}}
    target, actual_sid, actual_payload, messages = validate_plan(case, fixture, native_plan)
    require(actual_sid == sid and actual_payload == payload.encode() and messages == [source[0], *source],
            'Full UTF-8/newline history was not preserved')
    negatives = []
    for altered in ('role', 'parent', 'cwd', 'tool', 'body', 'last-prompt', 'session'):
        bad_rows = json.loads(json.dumps(rows))
        if altered == 'role':
            bad_rows[2]['message']['role'] = 'assistant'
        elif altered == 'parent':
            bad_rows[2]['parentUuid'] = None
        elif altered == 'cwd':
            bad_rows[2]['cwd'] = '/other/workspace'
        elif altered == 'tool':
            bad_rows[2]['message']['content'][0]['type'] = 'tool_use'
        elif altered == 'body':
            bad_rows[2]['message']['content'][0]['text'] = 'truncated'
        elif altered == 'last-prompt':
            bad_rows[-1]['lastPrompt'] = 'must never submit'
        else:
            bad_rows[2]['sessionId'] = str(uuid.UUID(int=999))
        bad = json.loads(json.dumps(native_plan))
        bad['change_set']['changes'][0]['after'] = '\n'.join(json.dumps(row) for row in bad_rows)
        negatives.append(bad)
    for altered in ('target', 'home', 'scope', 'existing', 'extra-change', 'archive'):
        bad = json.loads(json.dumps(native_plan))
        if altered == 'target':
            bad['launch_request']['target_path'] = '/synthetic/old-fixture/' + sid + '.jsonl'
        elif altered == 'home':
            bad['change_set']['requires_home_approval'] = False
        elif altered == 'scope':
            bad['change_set']['changes'][0]['scope'] = 'project'
        elif altered == 'existing':
            bad['change_set']['changes'][0]['original_hash'] = 'existing'
        elif altered == 'extra-change':
            bad['change_set']['changes'].append(bad['change_set']['changes'][0].copy())
        else:
            bad['launch_request']['archive_id'] = 'unexpected'
        negatives.append(bad)
    for bad in negatives:
        try:
            validate_plan(case, fixture, bad)
        except RuntimeError:
            continue
        raise RuntimeError('Unsafe native import plan accepted')
    print(json.dumps({'passed': True, 'reviewed_changeset_negative_cases': 3, 'no_terminal_pairing_or_model_RPC': True,
                      'full_UTF8_multiline_six_message_plan': True, 'native_plan_negative_cases': len(negatives),
                      'runtime_starts': 0, 'native_starts': 0, 'applies': 0, 'model_requests': 0}))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case', type=Path, default=DEFAULT_CASE)
    commands = parser.add_subparsers(dest='mode')
    prepare_parser = commands.add_parser('prepare')
    prepare_parser.add_argument('--source', choices=('b',), default='b')
    commands.add_parser('inspect')
    apply_parser = commands.add_parser('apply')
    apply_parser.add_argument('--reviewed-changeset', type=Path, required=True)
    commands.add_parser('selftest')
    args = parser.parse_args()
    {'prepare': prepare, 'apply': apply, 'inspect': inspect, 'selftest': selftest}[args.mode or 'inspect'](args)


if __name__ == '__main__':
    main()
