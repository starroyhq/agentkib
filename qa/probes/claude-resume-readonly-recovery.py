"""Finish evidence after an observation-only failure; existing completed receipt required.
No new user turn is permitted: native execution wrapper fails closed; exact stored fingerprint checked.
"""
import hashlib, json, os, pathlib, select, socket, sqlite3, subprocess, time

root = pathlib.Path('/private/tmp/agentkib-claude-resume-2026-09-30-once')
prior = json.loads((root / 'results.json').read_text())
source = pathlib.Path(prior['source'])
data = source / 'runtime-data'
request = prior['requestId']
session = prior['sessionId']
native = prior['nativeId']
with sqlite3.connect('file:' + str(data / 'codex-managed/executions.sqlite') + '?mode=ro', uri=True) as conn:
    fingerprint, phase, device, evidence = conn.execute('select fingerprint,phase,device_id,evidence from managed_commands where request_id=?', (request,)).fetchone()
assert phase == 'resolved', phase
evidence = json.loads(evidence)
params = dict(operation='send', sessionId=session, requestId=request, deviceId=device,
              expectedRevision=evidence['expectedRevision'], experimentalEnabled=True,
              text='Without reading files or using tools, recall from our previous conversation the exact secret marker and the chosen project storage namespace. Reply with those two values only. The answers are intentionally absent from this message.')
assert hashlib.sha256(json.dumps(params, sort_keys=True, separators=(',', ':')).encode()).hexdigest() == fingerprint
bin_dir = root / 'readonly-bin'
bin_dir.mkdir(exist_ok=True)
wrapper = bin_dir / 'claude'
wrapper.write_text('#!/bin/sh\nif [ "$1" = "--version" ]; then exec /Users/user/.local/bin/claude "$@"; fi\nexit 125\n')
wrapper.chmod(0o700)
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
(data/'preferences.json').write_text(json.dumps(dict(mcp_network=dict(port=port,lan_enabled=False,lan_risk_accepted=False))))
env=dict(os.environ, CLAUDE_CONFIG_DIR=str(source/'claude-config'), AGENTKIB_BENCHMARK_DATA_DIR=str(data), PATH=str(bin_dir)+':/usr/bin:/bin:/usr/sbin:/sbin')
workspace=pathlib.Path(__file__).resolve().parents[2]
child=subprocess.Popen([str(workspace/'target/debug/agentkib-runtime')],cwd=source/'workspace',env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
seq=0
out={'newModelSends':0,'nativeExecutionDisabled':True,'sourceResult':str(root/'results.json')}
def rpc(method,params):
    global seq
    seq+=1
    child.stdin.write(json.dumps(dict(jsonrpc='2.0',id=seq,method=method,params=params))+'\n'); child.stdin.flush()
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        assert select.select([child.stdout],[],[],max(0,deadline-time.monotonic()))[0], 'rpc_timeout'
        row=json.loads(child.stdout.readline())
        if row.get('id')==seq:
            assert 'error' not in row,row.get('error')
            return row['result']
    raise RuntimeError('rpc_timeout')
transcript=source/'claude-config/projects/-private-tmp-agentkib-claude-v1-native-2026-09-30-deepseek-workspace'/f'{native}.jsonl'
before=transcript.read_bytes()
try:
    rpc('agentkib.handshake',dict(protocolVersion=15,client=dict(name='readonly-resume-evidence',version='0.12.0')))
    receipt=rpc('control.receipt',dict(requestId=request,deviceId=device))
    assert receipt['status']=='accepted' and receipt['completionObserved'] is True,receipt
    out['receiptCompletedAfterRestart']=True
    events=rpc('web.request',dict(operation='events',sessionId=session,experimentalEnabled=True))
    assert prior['reply'] in '\n'.join(e.get('content') or '' for e in events['events'])
    out['nativeReplyRestoredAfterRestart']=True
    live=rpc('web.request',dict(operation='live',sessionId=session,experimentalEnabled=True))
    params['runtimeBootId']=live['runtimeBootId']
    ack=rpc('web.request',params)
    assert ack['accepted'] is True,ack
    out['exactRequestReplayAfterRestartAccepted']=True
    out['transcriptUnchanged']=transcript.read_bytes()==before
    assert out['transcriptUnchanged']
    rows=[json.loads(row) for row in before.decode().splitlines()]
    marker_index=next(i for i,row in enumerate(rows) if row.get('type')=='user' and params['text'] in json.dumps(row.get('message',{}).get('content')))
    out['nativeToolUsesInResumeTurn']=sum('"type": "tool_use"' in json.dumps(row.get('message',{}).get('content')) for row in rows[marker_index:])
    out['nativeUserTurnsMatchingPrompt']=sum(row.get('type')=='user' and params['text'] in json.dumps(row.get('message',{}).get('content')) for row in rows)
    out['nativeSessionFiles']=[p.name for p in transcript.parent.glob('*.jsonl')]
    assert out['nativeToolUsesInResumeTurn']==0
    assert out['nativeUserTurnsMatchingPrompt']==1
    assert out['nativeSessionFiles']==[f'{native}.jsonl']
    out['passed']=True
finally:
    child.stdin.close()
    try: child.wait(timeout=5)
    except subprocess.TimeoutExpired: child.kill(); child.wait()
    out['runtimeExit']=child.returncode
    (root/'recovery-results.json').write_text(json.dumps(out,indent=2))
print(json.dumps(out,indent=2))
