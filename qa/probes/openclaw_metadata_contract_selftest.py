"""Old native snapshots and deliberate field drift; no native/network calls."""
import copy
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
from openclaw_metadata_contract import validate_metadata

ROOT=Path('/Users/user/Documents/AgentKib-archives/2026-10-01/provider-retest/OpenClaw/grok-native-live-01')
OLD=ROOT/'offline-restart-fixed-v3'
summary=json.loads((OLD/'result.json').read_text())
with sqlite3.connect(OLD/'after-state.sqlite') as db:
    event=json.loads(db.execute('select payload_json from diagnostic_events').fetchone()[0])
raw=(ROOT/'isolated-config-before.json').read_bytes()
command={'pid':event['pid'],'supervisorPid':event['ppid'],'cwd':event['cwd'],'nativeArgv':event['argv'],'command':event['argv']}

def test(change=None,kind="state"):
    with tempfile.TemporaryDirectory() as d:
        d=Path(d)
        for stage in ('before','after'):
            for database_kind in ('state','agent'):shutil.copyfile(OLD/f'{stage}-{database_kind}.sqlite',d/f'{stage}-{database_kind}.sqlite')
        (d/'config-stat-before.json').write_text(json.dumps({k:event[k] for k in ('mtimeMs','ctimeMs','dev','ino','mode','nlink','uid','gid')}))
        if change:
            with sqlite3.connect(d/f'after-{kind}.sqlite') as db:change(db)
        return validate_metadata(d,summary['sessionKey'],'per-sender',summary['startedMs'],summary['startedMs']+20000,event['configPath'],raw,[command])
assert test()['passed']
negative=[
 lambda db:db.execute("UPDATE config_health_entries SET last_observed_suspicious_signature='fake'"),
 lambda db:db.execute("UPDATE config_health_entries SET last_promoted_good_json='{}'"),
 lambda db:db.execute("UPDATE config_health_entries SET updated_at_ms=1"),
 lambda db:db.execute("UPDATE schema_meta SET app_version='fake' WHERE meta_key='state-migrations'"),
 lambda db:db.execute("UPDATE schema_meta SET created_at=1 WHERE meta_key='state-migrations'"),
 lambda db:db.execute("UPDATE schema_meta SET schema_version=0 WHERE meta_key='primary'"),
 lambda db:db.execute("UPDATE diagnostic_events SET sequence=99"),
 lambda db:db.execute("UPDATE diagnostic_events SET event_key='fake'"),
 lambda db:db.execute("DELETE FROM diagnostic_events"),
 lambda db:db.execute("UPDATE config_machine_state SET value_json='\"other\"' WHERE state_key LIKE 'tui.lastSession.%'"),
]
for field,value in [('pid',1),('ppid',1),('phase','write'),('restoredFromBackup',True),('hash','other'),('bytes',2),('argv',[]),('valid',False),('unknown',None)]:
    def mutate(db,field=field,value=value):
        v=json.loads(db.execute('select payload_json from diagnostic_events').fetchone()[0]);v[field]=value
        db.execute('update diagnostic_events set payload_json=?',(json.dumps(v),))
    negative.append(mutate)
for action in negative:
    try:test(action)
    except (AssertionError,KeyError):pass
    else:raise AssertionError('Metadata drift accepted')
for statement in ["UPDATE session_key_contract SET main_key='other'","UPDATE session_key_contract SET updated_at=1","UPDATE session_key_contract SET canonical_ready='[1,\"main\",\"bad\",\"0\"]'"]:
    try:test(lambda db:db.execute(statement),'agent')
    except (AssertionError,KeyError,FileNotFoundError):pass
    else:raise AssertionError('Canonical receipt drift accepted')
NEW=Path('/Users/user/Documents/AgentKib-archives/2026-10-01/provider-retest/OpenClaw/completion-v2/mock-03/offline-restarts')
new_summary=json.loads((NEW/'result.json').read_text())
new_raw=(NEW.parent/'isolated-config-before.json').read_bytes()
new_config=NEW.parent/'openclaw/openclaw.json'
def fresh_test(statement=None,kind='agent'):
    with tempfile.TemporaryDirectory() as directory:
        p=Path(directory)
        for name in ('before-state.sqlite','after-state.sqlite','before-agent.sqlite','after-agent.sqlite',
                     'config-stat-before.json','agent-physical-before.json','agent-physical-after.json'):
            shutil.copyfile(NEW/name,p/name)
        if statement:
            with sqlite3.connect(p/f'after-{kind}.sqlite') as db:db.execute(statement)
        return validate_metadata(p,new_summary['sessionKey'],'per-sender',new_summary['startedMs'],
            new_summary['startedMs']+120000,new_config,new_raw,new_summary['commands'])
assert fresh_test()['passed']
for statement,kind in [("UPDATE session_key_contract SET canonical_ready='[1,\"main\",\"bad:inode\",\"0\"]'",'agent'),
    ("UPDATE session_key_contract SET canonical_ready=json_set(canonical_ready,'$[2]','wrong-inode')",'agent'),
    ("UPDATE session_key_contract SET canonical_ready=json_set(canonical_ready,'$[3]','wrong-birthtime')",'agent'),
    ("UPDATE agent_databases SET size_bytes=size_bytes+1",'state'),
    ("UPDATE agent_databases SET last_seen_at=1",'state'),
    ("UPDATE agent_databases SET path='wrong.sqlite'",'state')]:
    try:fresh_test(statement,kind)
    except AssertionError:pass
    else:raise AssertionError('Fresh physical metadata drift admitted')
print(json.dumps({'passed':True,'realSnapshotPositive':2,'metadataDriftNegatives':len(negative)+9,'modelRequests':0,'nativeProcesses':0}))
