"""One explicitly authorized Hermes reply under the supervised CPA retry window.

Usage: isolated-python hermes-cpa-native-once-live.py EXISTING_CASE RUNTIME
This sends a real model prompt. Never run as a preparation check.
"""
import hashlib,json,os,select,sqlite3,subprocess,sys,time
from pathlib import Path
import yaml
from cpa_once_relay import OnceRelay,verify_window,MODEL
from qa_owned_cli import run_owned_cli
from qa_native_sqlite import read_hermes_state,write_snapshot
from interop_native_readback import validate_receipts,verify_native_source

case,runtime=map(lambda x:Path(x).resolve(),sys.argv[1:])
window=Path(os.environ['AGENTKIB_RETRY_WINDOW']);verify_window(window)
attempt=case/'cpa-opus-once-2026-09-30'
if attempt.exists():raise SystemExit('Prior attempt exists; inspect evidence instead of retrying')
prior=json.loads((case/'result.json').read_text());validate_receipts(prior)
assert prior['target']=='hermes'
operation,=prior['operations'];launch=operation['launch_request'];sid=operation['target_session_id']
plan_file,=(case/'data/continuations').rglob('plan.json');raw=plan_file.read_bytes();plan=json.loads(raw)
receipt=json.loads(plan_file.with_name('receipt.json').read_text())
assert hashlib.sha256(raw).hexdigest()==launch['plan_hash']==receipt['plan_hash']
assert plan['schema_version']==receipt['schema_version']==1
assert plan['operation_id']==launch['operation_id'] and plan['workspace_id']==launch['workspace_id']
assert plan['target_agent']==launch['target_agent']=='hermes' and plan['target_profile']=='default'
assert receipt['target_session_id']==sid and receipt['verified'] is True and receipt['launched'] is True
assert plan['version']=='0.21.5' and plan['model'] is None
home=Path(plan['target_home']);assert home==case/'hermes'
env=json.loads((case/'environment.json').read_text());assert Path(env['HERMES_HOME'])==home
verify_native_source(prior,env)
workspace=Path(plan['workspace']);source=Path(prior['source'])
assert hashlib.sha256(source.read_bytes()).hexdigest()==prior['sourceSha256']
for metadata in prior.get('sourceMetadata',[]):assert hashlib.sha256(Path(metadata['path']).read_bytes()).hexdigest()==metadata['sha256']

def native_state():
 return read_hermes_state(home,sid)

before,total=native_state();assert total==1
expected=[{'role':t['role'],'text':'\n'.join(b['text'] for b in t['blocks'])} for t in plan['expected']['turns']]
assert all(b['type']=='text' for t in plan['expected']['turns'] for b in t['blocks'])
assert [{'role':row['role'],'text':row['content']} for row in before]==expected
attempt.mkdir(mode=0o700);write_snapshot(attempt/'before-native.json',before)
prompt='Recall the exact random marker and complete project storage decision from our previous history. Reply with those values only. Do not use tools.'
assert prior['marker'] not in prompt and prior['decision'] not in prompt
contract=attempt/'contract.json';contract.write_text(json.dumps({'endpoint':'http://127.0.0.1:8317/v1/chat/completions','model':MODEL,'stream':True,'sessionId':sid,'route':f'/session/{sid}/v1/chat/completions','history':expected,'prompt':prompt,'retryWindow':str(window)}))
try:cpa=yaml.safe_load(Path('/Users/user/proxy/CLIProxyAPI/config.yaml').read_text())
except yaml.YAMLError:raise SystemExit('CPA configuration is not valid YAML; refusing request') from None
keys=cpa['access']['api-keys'];assert isinstance(keys,list) and len(keys)==1 and isinstance(keys[0],str) and keys[0]
key=keys[0];del keys,cpa
config=home/'config.yaml';original=config.read_bytes();(attempt/'original-config.yaml').write_bytes(original)
result={'target':'hermes','model':MODEL,'sessionId':sid,'runtimeSha256':hashlib.sha256(runtime.read_bytes()).hexdigest(),'automaticRetriesPermitted':False,'modelBoundByImportPlan':False}
relay=OnceRelay(contract,key).start()
config_data={'updates':{'check':False},'model':{'provider':'agentkib-cpa','default':MODEL,'base_url':relay.base_url},'providers':{'agentkib-cpa':{'base_url':relay.base_url,'key_env':'AGENTKIB_QA_CPA_KEY','default_model':MODEL,'api_mode':'chat_completions'}},'toolsets':[],'platform_toolsets':{'cli':[]},'mcp_servers':{},'agent':{'api_max_retries':1,'auto_recovery_cycles':0},'compression':{'enabled':False},'memory':{'memory_enabled':False,'user_profile_enabled':False}}
modified=json.dumps(config_data).encode();live_env=dict(env,AGENTKIB_QA_CPA_KEY=key,OPENAI_BASE_URL=relay.base_url,HERMES_IGNORE_RULES='1');del key

def blocked():
 f=attempt/'relay-events.jsonl'
 events=[json.loads(line) for line in f.read_text().splitlines()] if f.exists() else []
 return any(e['event']=='blocked' and e.get('tokenConsumed') for e in events)

try:
 with (attempt/'run.stdout').open('w') as out,(attempt/'run.stderr').open('w') as err:
  run_owned_cli([plan['executable'],'--profile','default','chat','--resume',sid,'--no-restore-cwd','--model',MODEL,'--provider','agentkib-cpa','--query-file','-','--oneshot','--format','stream-json','--ignore-rules'],
    env=live_env,cwd=workspace,config=config,original=original,modified=modified,prompt=prompt,stdout=out,stderr=err,result=result,should_stop=blocked)
finally:
 try:relay.close()
 finally:(attempt/'result.json').write_text(json.dumps(result,indent=2))
verify_native_source(prior,env)
after,total=native_state();write_snapshot(attempt/'after-native.json',after)
assert after[:len(before)]==before and total==1
new=after[len(before):];reply='\n'.join(row['content'] or '' for row in new if row['role']=='assistant')
assert sum(row['role']=='user' for row in new)==1
assert all(row['role'] in ('user','assistant') for row in new)
assert hashlib.sha256(source.read_bytes()).hexdigest()==prior['sourceSha256']
assert all(hashlib.sha256(Path(entry['path']).read_bytes()).hexdigest()==entry['sha256'] for entry in prior.get('sourceMetadata',[]))
events=[json.loads(line) for line in (attempt/'relay-events.jsonl').read_text().splitlines()]
dispatches=sum(e['event']=='dispatch' for e in events);assert dispatches<=1
cli_results=[]
for line in (attempt/'run.stdout').read_text().splitlines():
 try:value=json.loads(line)
 except json.JSONDecodeError:continue
 if value.get('type')=='result':cli_results.append(value)
result.update(reply=reply,markerMatched=prior['marker'] in reply,decisionMatched=prior['decision'].casefold() in reply.casefold(),providerDispatches=dispatches,providerStatuses=[e['status'] for e in events if e['event']=='response'],cliResults=cli_results,importedPrefixUnchanged=True,nativeSessionCount=total,sourceUnchanged=True)
(attempt/'result.json').write_text(json.dumps(result,indent=2))
# Restart the native state reader and existing Runtime receipt, without asking any model.
launch_request=next(json.loads(line)['request']['params'] for line in (case/'rpc.jsonl').read_text().splitlines() if json.loads(line).get('request',{}).get('method')=='sessions.continueHandoff')
process=subprocess.Popen([str(runtime)],env=env,cwd=workspace,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(attempt/'runtime.stderr').open('w'))
seq=0;buffer=b''
def rpc(method,params):
 global seq,buffer
 seq+=1;process.stdin.write((json.dumps({'jsonrpc':'2.0','id':seq,'method':method,'params':params})+'\n').encode());process.stdin.flush();deadline=time.monotonic()+60
 while time.monotonic()<deadline:
  if b'\n' not in buffer:
   assert select.select([process.stdout],[],[],max(0,deadline-time.monotonic()))[0]
   chunk=os.read(process.stdout.fileno(),65536);assert chunk;buffer+=chunk
  line,buffer=buffer.split(b'\n',1);value=json.loads(line)
  if value.get('id')==seq:
   assert 'error' not in value;return value['result']
 raise TimeoutError('Readonly Runtime response')
try:
 rpc('agentkib.handshake',{'protocolVersion':15,'client':{'name':'hermes-once-readonly','version':'1'}})
 ops=rpc('sessions.nativeImports',{'workspaceId':plan['workspace_id']});assert len(ops)==1 and ops[0]==operation
 recovered=rpc('sessions.continueHandoff',launch_request);assert recovered['status']=='launched'
 result['runtimeExistingOperationReconciled']=True
finally:
 try:
  if process.poll() is None:rpc('agentkib.shutdown',{});process.stdin.close();process.wait(timeout=15)
 finally:
  if process.poll() is None:
   process.terminate()
   try:process.wait(timeout=3)
   except subprocess.TimeoutExpired:process.kill();process.wait(timeout=3)
  (attempt/'result.json').write_text(json.dumps(result,indent=2))
final,total=native_state();assert final==after and total==1
result['readonlyRecoveryDidNotSendOrCreate']=True
result['realReplyPassed']=(result['markerMatched'] and result['decisionMatched'] and dispatches==1 and result['providerStatuses']==[200]
 and result['cliExitCode']==0 and len(cli_results)==1 and cli_results[0]['exit_code']==0 and not cli_results[0].get('error')
 and cli_results[0].get('session_id')==sid and result.get('ownedCliCleanupCompleted') is True and result.get('isolatedConfigRestored') is True)
(attempt/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
