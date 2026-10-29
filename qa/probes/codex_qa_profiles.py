"""Only reviewed local Codex binaries; no installation or credential discovery."""
from pathlib import Path
from deepseek_once_relay import digest

BATCH = Path('/Users/user/Documents/AgentKib-archives/2026-10-01/codex-completion-batch')
PROFILES = {
    '0.146.1': (Path('/Users/user/Documents/AgentKib-archives/2026-09-30/full-interop/tools-codex146/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'),
                '35d248101b211d6248ad4e6b8c1d441fe81236da87afb9f3e9ea51a049e9f179'),
    '0.155.1': (BATCH / 'tools/codex-0.155.1',
                '8eaf1ad12fe6bf89b1710330f58900014322c7c5af677e43be116d8ac5fc0a9e'),
}


def binary_profile(version):
    binary, expected = PROFILES[version]
    assert binary.is_file() and not binary.is_symlink()
    assert digest(binary.read_bytes()) == expected, 'Reviewed Codex binary changed'
    return binary, expected


def public_snapshot(case, expected_source=None, *, exact_target=True):
    """Accept the reviewed public ChangeSet, never copy native absolute indexes."""
    import json
    import sqlite3
    case = Path(case).resolve()
    prior = json.loads((case / 'result.json').read_text())
    plan_path = case / 'file-plan.json'
    if not plan_path.exists(): plan_path = case / 'plan.json'
    raw = plan_path.read_bytes(); plan = json.loads(raw)
    launch = plan['launch_request']; target = Path(launch['target_path']).resolve()
    sid = launch['target_session_id']
    assert prior['target'] == launch['target_agent'] == 'codex'
    assert prior['first']['status'] == 'launched' and prior['reopen']['target_agent'] == 'codex'
    assert prior['first']['receipt']['target_agent'] == 'codex'
    repeated = prior.get('repeat', prior.get('duplicate'))
    assert repeated['rpcError']['code'] == -32000
    assert repeated['rpcError']['data']['detail'] == 'File was modified externally: ' + str(target)
    assert target.is_relative_to(case / 'codex/sessions') and sid in target.name
    if expected_source is not None: assert prior['sourceAgent'] == expected_source
    payload, = [x['after'].encode() for x in plan['change_set']['changes'] if x['target'] == str(target)]
    current = target.read_bytes()
    assert current == payload if exact_target else current.startswith(payload)
    files = prior.get('sourceFiles') or {
        prior['source']: prior['sourceSha256'],
        **{x['path']: x['sha256'] for x in prior.get('sourceMetadata', [])}}
    assert all(digest(Path(path).read_bytes()) == sha for path, sha in files.items())
    rows = [json.loads(line) for line in payload.splitlines()]
    assert rows[0]['type'] == 'session_meta'
    assert rows[0]['payload']['id'] == sid and rows[0]['payload']['cwd'] == str(case / 'workspace')
    history = []
    for row in rows:
        if row['type'] != 'response_item': continue
        m = row['payload']; assert m['type'] == 'message' and m['role'] in ('user', 'assistant')
        p, = m['content']; assert set(p) == {'type', 'text'}
        assert p['type'] == ('input_text' if m['role'] == 'user' else 'output_text')
        history.append({'role': m['role'], 'text': p['text']})
    assert [x['role'] for x in history] == ['user', 'user', 'assistant']
    # A CLI may have created either version's index during a zero-input launch.
    for database in (case / 'codex').glob('state_*.sqlite'):
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as db:
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='threads'").fetchone():
                assert db.execute('SELECT id,rollout_path FROM threads').fetchall() == [(sid, str(target))]
    return prior, target, sid, payload, history, files, digest(raw)
