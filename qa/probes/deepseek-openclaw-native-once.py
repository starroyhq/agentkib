"""Pinned synthetic OpenClaw import: mock first, then one direct DeepSeek turn.

No global config, credential file, import retry, or wire-body transformation.
The historical timestamp, adjacent users, and fixed native Runtime annotation
are validated explicitly; all imported text and ordering remain exact.
"""
import argparse
import copy
from datetime import datetime, timezone, timedelta
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import ssl
import threading
import time

from deepseek_once_relay import (MODEL, digest, private_json, load_current_provider,
                                 synthetic_provider, start_relay)
from qa_owned_cli import run_owned_cli
from interop_native_readback import validate_receipts, verify_native_source

HERE=Path(__file__).resolve().parent
_spec=importlib.util.spec_from_file_location('openclaw_owned',HERE/'native-offline-tui.py')
OWNED=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(OWNED)
PROVIDER = 'agentkib-deepseek'
NODE = '/opt/homebrew/Cellar/node/26.9.0/bin/node'
CANCELLED = []
CA_PATH = Path('/Users/user/Library/Python/3.11/lib/python/site-packages/certifi/cacert.pem')
CA_SHA = 'c55b21f907f7f86d48add093552fb5651749ff5f860508ccbb423d6c1fbd80c7'
PROMPT = ('Recall the exact random marker and complete project storage decision from our previous history. '
          'Reply with those values only. Do not use tools.')
READ_SCRIPT = """
import {pathToFileURL} from 'node:url';
const p=JSON.parse(process.argv[1]);
const load=n=>import(pathToFileURL(p.package+'/dist/'+n));
const {n:readOnly}=await load('openclaw-agent-db-readonly-IBx2zWDG.mjs');
const {l:events}=await load('session-accessor.sqlite-read-DG0i0-yW.mjs');
const out=readOnly(d=>({events:events(d,p.sid),count:d.db.prepare('SELECT COUNT(*) AS n FROM session_nodes').get().n,
matches:d.db.prepare('SELECT COUNT(*) AS n FROM session_nodes WHERE current_session_id=?').get(p.sid).n}),
{agentId:'main',env:process.env,path:p.database});
if(!out.found)throw Error('Missing native database');console.log(JSON.stringify(out.value));
"""


def validate_projection(body, contract, now=None):
    assert set(body)=={'model','messages','stream','stream_options','max_completion_tokens','thinking','reasoning_effort'}
    assert body['model']==MODEL and body['stream'] is True
    assert body['stream_options']=={'include_usage':True} and body['stream_options']['include_usage'] is True
    assert type(body['max_completion_tokens']) is int
    assert contract['openclawVersion'] == '2026.9.6'
    assert body.get('thinking') == {'type': 'enabled'}
    assert body.get('reasoning_effort') == 'high'
    assert body.get('max_completion_tokens') == 4096
    assert 'max_tokens' not in body
    history = contract['history']
    assert [m['role'] for m in history] == ['user', 'user', 'assistant']
    messages = body['messages']
    assert len(messages) == 4 and [m['role'] for m in messages] == ['system', 'user', 'assistant', 'user']
    assert all(set(m) == {'role', 'content'} for i,m in enumerate(messages) if i != 2)
    assert set(messages[2]) == {'role','content','reasoning_content'} and messages[2]['reasoning_content'] == ''
    system = messages[0]['content']
    assert isinstance(system, str) and system.count('Current model identity: ' + PROVIDER + '/' + MODEL + '.') == 1
    assert messages[1]['content'] == [
        {'type': 'text', 'text': contract['historicalEnvelope'] + history[0]['text']},
        {'type': 'text', 'text': history[1]['text']},
        {'type': 'text', 'text': contract['runtimeLine']},
    ]
    assert messages[2]['content'] == history[2]['text']
    match = re.fullmatch(r'\[([A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2}) GMT\+8\] (.*)', messages[3]['content'], re.S)
    assert match and match[2] == contract['prompt']
    stamp = datetime.strptime(match[1], '%a %Y-%m-%d %H:%M').replace(tzinfo=timezone(timedelta(hours=8)))
    assert stamp.strftime('%a %Y-%m-%d %H:%M') == match[1]
    assert contract['startedAt'] - 60 <= stamp.timestamp() <= (now or time.time())
    return {'historyValidated': True, 'sessionId': contract['sessionId'],
            'nativeSystemSha256': digest(system.encode()), 'completeImportedTextAndRoles': True,
            'reviewedNativeProjection': ['Adjacent users represented as separate text blocks',
                'Fixed import timestamp envelope', 'Exact native Runtime identity annotation',
                'New prompt timestamp bounded by this attempt'], 'wireBodyRewritten': False}


def projection_selftest():
    now = datetime.now(timezone(timedelta(hours=8)))
    contract = {'openclawVersion': '2026.9.6', 'history': [
        {'role': 'user', 'text': 'notice'}, {'role': 'user', 'text': 'random marker and decision'},
        {'role': 'assistant', 'text': 'full confirmation'}], 'prompt': PROMPT, 'sessionId': 'synthetic',
        'historicalEnvelope': '[Wed 2026-09-30 20:00 GMT+8] ', 'runtimeLine': 'exact runtime',
        'startedAt': time.time()}
    body = {'model':MODEL,'stream':True,'stream_options':{'include_usage':True},'thinking': {'type':'enabled'}, 'reasoning_effort':'high', 'max_completion_tokens':4096, 'messages': [{'role': 'system', 'content': 'Current model identity: ' + PROVIDER + '/' + MODEL + '.'},
        {'role': 'user', 'content': [
            {'type': 'text', 'text': contract['historicalEnvelope'] + 'notice'},
            {'type': 'text', 'text': 'random marker and decision'}, {'type': 'text', 'text': 'exact runtime'}]},
        {'role': 'assistant', 'content': 'full confirmation', 'reasoning_content':''},
        {'role': 'user', 'content': now.strftime('[%a %Y-%m-%d %H:%M GMT+8] ') + PROMPT}]}
    validate_projection(body, contract)
    failures = []
    for key,value in [('unknown',True),('stream',1),('stream_options',{'include_usage':False}),('stream_options',{'include_usage':1}),('stream_options',{'include_usage':True,'extra':0})]:
        bad=copy.deepcopy(body);bad[key]=value;failures.append(bad)
    for key, value in [('thinking', {'type':'disabled'}), ('reasoning_effort','low'), ('max_completion_tokens',1024)]:
        bad = copy.deepcopy(body); bad[key] = value; failures.append(bad)
    for index in range(3):
        bad = copy.deepcopy(body); bad['messages'][1]['content'][index]['text'] += ' drift'; failures.append(bad)
    for index in (2, 3):
        bad = copy.deepcopy(body); bad['messages'][index]['content'] += ' drift'; failures.append(bad)
    bad = copy.deepcopy(body); bad['messages'][0]['content'] = 'Wrong native model identity'; failures.append(bad)
    for index in range(4):
        bad = copy.deepcopy(body); bad['messages'][index]['role'] = 'tool'; failures.append(bad)
    bad = copy.deepcopy(body); bad['messages'].append({'role': 'user', 'content': 'extra'}); failures.append(bad)
    for stamp in ('[Wed 2000-01-01 20:00 GMT+8] ', '[Wed 2099-01-01 20:00 GMT+8] '):
        bad = copy.deepcopy(body); bad['messages'][3]['content'] = stamp + PROMPT; failures.append(bad)
    bad = copy.deepcopy(body); bad['messages'][2]['tool_calls'] = []; failures.append(bad)
    for bad in failures:
        try: validate_projection(bad, contract)
        except (AssertionError, TypeError, ValueError): continue
        raise AssertionError('Invalid native projection admitted')
    return {'passed': True, 'negativeProjectionCases': len(failures), 'nativeRequests': 0, 'modelRequests': 0}


def native_content(message):
    value = message.get('content', [])
    if isinstance(value, str): return value
    assert isinstance(value, list) and all(isinstance(b, dict) and b['type'] in ('text', 'thinking') for b in value)
    return '\n'.join(b['text'] for b in value if b['type'] == 'text')


class Capture:
    def __init__(self):
        self.read_fd, self.write_fd = os.pipe(); self.data = bytearray(); self.exceeded = threading.Event()
        self.thread = threading.Thread(target=self.read, daemon=True); self.thread.start()
    def read(self):
        try:
            while chunk := os.read(self.read_fd, 65536):
                room = 4 * 1024 * 1024 - len(self.data)
                self.data.extend(chunk[:room])
                if len(chunk) > room: self.exceeded.set()
        finally: os.close(self.read_fd)
    def finish(self, path, relay):
        os.close(self.write_fd); self.thread.join(timeout=4)
        assert not self.thread.is_alive(), 'Owned output pipe did not close'
        data = relay.redact(bytes(self.data)); path.write_bytes(data); return data


def synthetic_success(reply):
    # In-memory SDK transport only: no socket, provider credentials or TLS.
    payload = ('data: '+json.dumps({'id':'mock','model':MODEL,'choices':[{'index':0,'delta':{'role':'assistant','content':reply},'finish_reason':None}]})+
        '\n\ndata: '+json.dumps({'id':'mock','model':MODEL,'choices':[{'index':0,'delta':{},'finish_reason':'stop'}]})+'\n\ndata: [DONE]\n\n').encode()
    class Socket:
        def settimeout(self,_): pass
        def shutdown(self,_): pass
        def close(self): pass
    class Response:
        status=200
        def getheader(self,*_): return 'text/event-stream'
        def read(self,_): return payload
    class Connection:
        def __init__(self,*_,**__): self.sock=None
        def connect(self): self.sock=Socket()
        def request(self,method,path,body,headers): assert method=='POST' and path=='/chat/completions'
        def getresponse(self): return Response()
        def close(self): pass
    return Connection


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('public_case', type=Path, nargs='?')
    parser.add_argument('attempt', type=Path, nargs='?')
    parser.add_argument('--mock', action='store_true')
    parser.add_argument('--mock-success', action='store_true')
    parser.add_argument('--selftest', action='store_true')
    args = parser.parse_args()
    if args.selftest:
        print(json.dumps(projection_selftest())); return
    assert args.public_case and args.attempt and os.uname().sysname == 'Darwin'
    assert digest(Path(NODE).read_bytes()) == '91ed66b8cd139609427a3e9d93518dd3b0d5407c737fc9a265bfd991ec623d8a'
    assert not args.mock_success or args.mock
    os.umask(0o077)
    source, evidence = args.public_case.resolve(), args.attempt.resolve()
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    private_json(evidence / 'attempt.json', {'publicCase': str(source), 'mock': args.mock,
                                          'automaticRetry': False, 'modelSwitch': False})
    prior = json.loads((source / 'result.json').read_text())
    validate_receipts(prior)
    plan_path, = (source / 'data/continuations').rglob('plan.json')
    plan = json.loads(plan_path.read_text())
    assert plan['version'] == '2026.9.6' and prior['target'] == 'openclaw'
    assert json.loads((Path(plan['openclaw']['package'])/'package.json').read_text())['version']=='2026.9.6'
    assert digest(plan_path.read_bytes()) == prior['operations'][0]['launch_request']['plan_hash']
    sid = prior['operations'][0]['target_session_id']
    assert PROMPT.find(prior['marker']) < 0 and PROMPT.find(prior['decision']) < 0
    def check_source():
        assert digest(Path(prior['source']).read_bytes()) == prior['sourceSha256']
        for item in prior.get('sourceMetadata', []):
            assert digest(Path(item['path']).read_bytes()) == item['sha256']
        verify_native_source(prior, json.loads((source / 'environment.json').read_text()))
    check_source()
    state = source / 'openclaw'
    if args.mock:
        copied = evidence / 'openclaw'; copied.mkdir()
        for path in state.rglob('*'):
            if not path.is_file() or path.name.endswith(('-wal', '-shm')) or 'lock' in path.name: continue
            dest = copied / path.relative_to(state); dest.parent.mkdir(parents=True, exist_ok=True)
            if path.read_bytes()[:16] == b'SQLite format 3\0':
                with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db, sqlite3.connect(dest) as target: db.backup(target)
            else: shutil.copyfile(path, dest)
        state = copied
    workspace = Path(plan['workspace'])
    env = {'HOME': str(source / 'home'), 'OPENCLAW_STATE_DIR': str(state),
           'OPENCLAW_CONFIG_PATH': str(state / 'openclaw.json'), 'PATH': '/opt/homebrew/bin:/usr/bin:/bin',
           'TERM': 'dumb', 'LANG': 'en_US.UTF-8'}
    for key in ('DATA', 'CONFIG', 'CACHE', 'STATE'): env['XDG_' + key + '_HOME'] = str(source / key.lower())
    spec = {'package': plan['openclaw']['package'], 'sid': sid,
            'database': str(state / 'agents/main/agent/openclaw-agent.sqlite')}
    reads=[]
    def read_native():
        path=evidence/('official-read-'+str(len(reads))+'.ansi')
        record=OWNED.run_owned(OWNED.SANDBOX+[NODE,'--input-type=module','-e',READ_SCRIPT,json.dumps(spec)],
            {k:v for k,v in env.items() if k != 'AGENTKIB_QA_LOOPBACK_KEY'},str(workspace),path,timeout=20)
        reads.append(record)
        assert record['ownedProcessGroupGone'] and record['exitCodeAfterCleanup']==0 and record['cancellationSignal'] is None
        return json.loads(path.read_text())
    before = read_native(); expected = json.loads(plan['payload'])
    assert before['events'] == expected and before['matches'] == 1 and before['count'] == 6
    private_json(evidence / 'native-before.json', before)
    history = [{'role':t['role'], 'text':'\n'.join(b['text'] for b in t['blocks'])} for t in plan['expected']['turns']]
    snapshot = synthetic_provider() if args.mock else load_current_provider()
    private_json(evidence / 'provider.json', snapshot.safe_metadata())
    if not args.mock:
        assert os.environ.get('SSL_CERT_FILE') == str(CA_PATH) and digest(CA_PATH.read_bytes()) == CA_SHA
        context = ssl.create_default_context()
        assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname
        private_json(evidence / 'tls-preflight.json', {'path':str(CA_PATH),'sha256':CA_SHA,'certificateVerification':True,'hostnameVerification':True})
        private_json(source / 'deepseek-native-attempt-consumed.json', {'sessionId':sid,
            'evidence':str(evidence), 'providerFingerprint':snapshot.fingerprint})
    frozen_sources = {'runner.py':Path(__file__).read_bytes(),
                      'relay-source.py':(Path(__file__).parent / 'deepseek_once_relay.py').read_bytes(),
                      'owned-source.py':(Path(__file__).parent/'qa_owned_cli.py').read_bytes(),
                      'native-owned-source.py':(HERE/'native-offline-tui.py').read_bytes()}
    for name, data in frozen_sources.items(): (evidence / name).write_bytes(data)
    first_message = expected[1]
    assert first_message['type'] == 'message' and first_message['message']['role'] == 'user'
    timestamp_ms = first_message['message']['timestamp']
    assert type(timestamp_ms) is int and timestamp_ms >= 0
    historical_envelope = datetime.fromtimestamp(timestamp_ms / 1000, timezone(timedelta(hours=8))).strftime('[%a %Y-%m-%d %H:%M GMT+8] ')
    contract = {'schemaVersion':1, 'protocol':'chat', 'model':MODEL, 'stream':True, 'tools':'none',
        'providerFingerprint':snapshot.fingerprint, 'sessionId':sid, 'history':history, 'prompt':PROMPT,
        'openclawVersion':'2026.9.6', 'historicalEnvelope':historical_envelope,
        'startedAt':time.time(), 'runtimeLine':f'Runtime: agent=main | session=agent:main:agentkib:{sid} | '
        f'sessionId={sid} | host=MacBook Pro | os=macOS 27.0.1 (arm64) | node=v26.9.0 | active_node=unknown | '
        f'model={PROVIDER}/{MODEL} | default_model={PROVIDER}/{MODEL}'}
    private_json(evidence / 'contract.json', contract)
    kwargs = {'_connection_factory':synthetic_success(prior['marker']+'; '+prior['decision'])} if args.mock_success else {}
    relay = start_relay(evidence / 'contract.json', snapshot, offline=args.mock, validator=validate_projection, **kwargs)
    if args.mock:
        admit = relay.admit
        def observe(route, headers, raw):
            if not (evidence / 'observed-native-request.json').exists():
                private_json(evidence / 'observed-native-request.json', json.loads(relay.redact(raw)))
                private_json(evidence / 'observed-native-route.json', {'path': route})
            return admit(route, headers, raw)
        relay.admit = observe
    config = {'gateway':{'mode':'local','bind':'loopback','auth':{'mode':'none'}},
        'agents':{'defaults':{'workspace':str(workspace),'skipBootstrap':True,'model':{'primary':PROVIDER+'/'+MODEL}},
                  'entries':{'main':{'workspace':str(workspace)}}}, 'plugins':{'enabled':False}, 'tools':{'deny':['*']},
        'models':{'mode':'replace','providers':{PROVIDER:{'baseUrl':relay.base_url,
        'apiKey':{'source':'env','provider':'default','id':'AGENTKIB_QA_LOOPBACK_KEY'}, 'api':'openai-completions',
        'models':[{'id':MODEL,'name':'Selected official DeepSeek Pro','reasoning':True,'input':['text'],
                   'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0},'contextWindow':200000,'maxTokens':4096,
                   'compat':{'supportsTools':False}}]}}}}
    config_path = state / 'openclaw.json'; original = config_path.read_bytes()
    (evidence / 'isolated-config-before.json').write_bytes(original)
    modified = json.dumps(config).encode()
    env['AGENTKIB_QA_LOOPBACK_KEY'] = relay.client_token
    result = {'mock': args.mock, 'sessionId':sid, 'model':MODEL, 'modelBoundByImportPlan':False,
              'sourceAgent':prior.get('sourceAgent','claude-code'), 'targetVersion':'2026.9.6','thinkingLevel':'medium','maxCompletionTokens':4096,
              'actualNode':NODE,'actualNodeSha256':digest(Path(NODE).read_bytes()),
              'implementationSHA256':{k:digest(v) for k,v in frozen_sources.items()},
              'entrySha256':digest(Path(plan['executable']).read_bytes()),
              'realProviderRequests':0 if args.mock else None, 'syntheticSuccess':args.mock_success}
    stdout, stderr = Capture(), Capture()
    try:
        try:
                if CANCELLED: raise SystemExit(128 + CANCELLED[0])
                run_owned_cli(['/usr/bin/sandbox-exec','-p',relay.sandbox_profile, NODE, plan['executable'],
                    'agent','--local','--agent','main','--session-id',sid,'--message',PROMPT,'--json','--thinking','medium','--timeout','160'],
                    env=env,cwd=workspace,config=config_path,original=original,modified=modified,prompt='',stdout=stdout.write_fd,
                    stderr=stderr.write_fd,result=result,should_stop=lambda:bool(CANCELLED) or relay.summary()['blocked'] > 0 or stdout.exceeded.is_set() or stderr.exceeded.is_set(),timeout=180)
                if args.mock and os.environ.get('AGENTKIB_QA_MOCK_CANCEL_STAGE') == 'after-helper':
                    os.kill(os.getpid(), signal.SIGTERM)
        except BaseException as exc:
                result['executionErrorType'] = type(exc).__name__
    finally:
        try: relay.close()
        finally:
            out = stdout.finish(evidence / 'stdout', relay); stderr.finish(evidence / 'stderr', relay)
        result['relay'] = relay.summary()
    if args.mock and os.environ.get('AGENTKIB_QA_MOCK_CANCEL_STAGE') == 'after-close':
        os.kill(os.getpid(), signal.SIGTERM)
    after = read_native(); restart = read_native()
    private_json(evidence / 'native-after.json', after); private_json(evidence / 'native-after-restart.json', restart)
    assert after == restart and after['events'][:len(expected)] == expected
    assert after['matches'] == 1 and after['count'] == before['count']
    check_source()
    result['officialReads']=reads
    result['ownedProcessGroupGone']=not OWNED.group_exists(result['ownedCliPid'])
    assert result['ownedProcessGroupGone']
    result.update(sourceUnchanged=True, importedNativePrefixUnchanged=True, nativeSessionCount=after['count'],
                  importedSessionCount=1, readOnlyRestartStable=True, originalConfigByteRestored=config_path.read_bytes()==original)
    added = [e['message'] for e in after['events'][len(expected):] if e.get('type') == 'message']
    result['newMessageRoles'] = [m['role'] for m in added]
    assert all(m['role'] in ('user','assistant') for m in added)
    contents = [(m['role'], native_content(m)) for m in added]
    result['historyToolsNotReplayed'] = True
    replies = [text for role, text in contents if role == 'assistant']
    result['replyProvesImportedContext'] = any(prior['marker'] in text and prior['decision'] in text for text in replies)
    result['nativeUsage'] = [m.get('usage') for m in added if m['role']=='assistant']
    new_users = [text for role, text in contents if role == 'user']
    result['singleUserTurn'] = new_users == [PROMPT]
    result['singleDispatchVerified'] = result['relay']['admitted']==1 and result['relay']['dispatchAttempts']==(0 if args.mock and not args.mock_success else 1)
    result['passed'] = all(result.get(k) for k in ('sourceUnchanged','importedNativePrefixUnchanged','historyToolsNotReplayed',
        'isolatedConfigRestored','ownedCliCleanupCompleted','originalConfigByteRestored','readOnlyRestartStable','singleDispatchVerified'))
    successful_reply = not args.mock or args.mock_success
    if successful_reply:
        cli = json.loads(out)
        meta = cli['meta']['agentMeta']
        payload_texts = [p['text'] for p in cli['payloads']]
        result['cliReplyExactlyMatchesNative'] = payload_texts == [t for t in replies if t]
        result['singleCompleteAssistant'] = len(replies)==1 and all(m.get('stopReason')=='stop' for m in added if m['role']=='assistant')
        result['cliIdentityMatches'] = meta['sessionId'] == sid and meta['provider'] == PROVIDER and meta['model'] == MODEL
        result['cliUsage'] = meta.get('usage')
        result['passed'] &= result['singleCompleteAssistant'] and result['cliReplyExactlyMatchesNative'] and result['cliIdentityMatches'] and result['relay']['blocked']==0
    result['passed'] &= (result['cliExitCode'] != 0 if not successful_reply else result['cliExitCode']==0 and
        result['replyProvesImportedContext'] and result['singleUserTurn'] and result['relay']['responses']==[200])
    result['passed'] &= not result.get('executionErrorType') and not result.get('cancellationSignals') and not stdout.exceeded.is_set() and not stderr.exceeded.is_set()
    result['credentialNotPersisted'] = True
    for root in (evidence, state):
        for path in root.rglob('*'):
            if path.is_file() and not path.is_symlink():
                data = path.read_bytes()
                if args.mock and path.parent == evidence and path.name in frozen_sources:
                    # Reviewed code snapshots include a public offline fixture
                    # literal. This exception never permits the random token.
                    assert data == frozen_sources[path.name]
                    data = data.replace(synthetic_provider()._credential.encode(), b'[STATIC-OFFLINE-FIXTURE]')
                assert relay.redact(data) == data, 'Credential/token reached a native or evidence file'
    result['outerCancellationSignals'] = list(CANCELLED)
    result['passed'] &= not CANCELLED
    private_json(evidence / 'result.json', result)
    print(json.dumps(result)); assert result['passed'], 'Native acceptance failed; attempt retained, no retry'


if __name__ == '__main__':
    previous = {}
    def defer_cancel(sig, _frame): CANCELLED.append(sig)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): previous[sig] = signal.signal(sig, defer_cancel)
    try: main()
    except BaseException as exc:
        # Preserve a diagnostic even if source/readback validation itself fails.
        # Never serialize exception values that might contain private input.
        if len(__import__('sys').argv) >= 3:
            path = Path(__import__('sys').argv[2])
            if path.is_dir() and not (path / 'execution-error.json').exists():
                private_json(path / 'execution-error.json', {'errorType':type(exc).__name__,
                    'outerCancellationSignals':list(CANCELLED), 'passed':False})
        raise
    finally:
        for sig, handler in previous.items(): signal.signal(sig, handler)
