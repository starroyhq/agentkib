"""Capture pinned Codex's actual Responses envelope without provider access.

Copies a previously verified public fixture into a new private mock directory.
The strict relay may reject unsupported tools/history. Rejection is evidence,
not permission to relax validation or a real-reply pass.
"""
import hashlib
import argparse
import importlib.util
import json
import os
from pathlib import Path
import select
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
from deepseek_once_relay import MODEL, private_json, start_relay, synthetic_provider
from codex_qa_profiles import PROFILES, binary_profile, public_snapshot

BINARY = Path('/Users/user/Documents/AgentKib-archives/2026-09-30/full-interop/tools-codex146/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex')
BINARY_SHA = '35d248101b211d6248ad4e6b8c1d441fe81236da87afb9f3e9ea51a049e9f179'
PROMPT = 'Recall the exact random marker and complete project storage decision from our previous history. Reply with those values only. Do not use tools.'
spec=importlib.util.spec_from_file_location('owned_native',Path(__file__).parent/'native-offline-tui.py')
OWNED=importlib.util.module_from_spec(spec);spec.loader.exec_module(OWNED)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path); parser.add_argument('case', type=Path)
    parser.add_argument('--profile', choices=PROFILES, default='0.146.1')
    args = parser.parse_args()
    source, case = args.source.resolve(), args.case.resolve()
    binary, binary_sha = binary_profile(args.profile)
    os.umask(0o077); case.mkdir(mode=0o700, parents=True, exist_ok=False)
    prior, target, sid, payload, history, source_files, _ = public_snapshot(source, exact_target=False)
    baseline=target.read_bytes()
    assert baseline.startswith(payload) and not (source / 'codex/auth.json').exists()
    def source_unchanged():
        assert all(hashlib.sha256(Path(p).read_bytes()).hexdigest() == h for p,h in source_files.items())
        assert target.read_bytes() == baseline
    source_unchanged()
    home, codex = case / 'home', case / 'codex'; home.mkdir(); codex.mkdir()
    # Copying state SQLite would retain an absolute rollout_path pointing back
    # into the public case. A mock fixture gets only the frozen renderer payload;
    # the native CLI must discover and index its own local file from scratch.
    dest=codex/target.relative_to(source/'codex');dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(payload)
    rows = [json.loads(x) for x in payload.splitlines()]
    history = [{'role':r['payload']['role'],'text':p['text']} for r in rows if r['type']=='response_item'
               and r['payload']['type']=='message' for p in r['payload']['content']]
    assert len(history)==3 and prior['marker'] not in PROMPT and prior['decision'] not in PROMPT
    snapshot = synthetic_provider()
    private_json(case/'contract.json',{'schemaVersion':1,'protocol':'responses','model':MODEL,'stream':True,
        'tools':'none','sessionId':sid,'providerFingerprint':snapshot.fingerprint,'history':history,'prompt':PROMPT})
    relay = start_relay(case/'contract.json',snapshot,offline=True)
    original_admit = relay.admit
    def observe(route,headers,raw):
        if not (case/'native-request.json').exists():
            private_json(case/'native-request.json',json.loads(relay.redact(raw)))
            private_json(case/'request-path.json',{'path':route})
        return original_admit(route,headers,raw)
    relay.admit = observe
    env={'HOME':str(home),'CODEX_HOME':str(codex),'PATH':'/usr/bin:/bin','TERM':'dumb','LANG':'en_US.UTF-8',
         'AGENTKIB_QA_LOOPBACK_KEY':relay.client_token}
    overrides={'model_provider':'qa-deepseek','model_providers.qa-deepseek.name':'Official DeepSeek QA',
        'model_providers.qa-deepseek.base_url':relay.base_url,'model_providers.qa-deepseek.env_key':'AGENTKIB_QA_LOOPBACK_KEY',
        'model_providers.qa-deepseek.wire_api':'responses','model_providers.qa-deepseek.requires_openai_auth':False,
        'model_providers.qa-deepseek.supports_websockets':False,'model_providers.qa-deepseek.request_max_retries':0,
        'model_providers.qa-deepseek.stream_max_retries':0,'check_for_update_on_startup':False,'web_search':'disabled',
        'features.shell_snapshot':False,'features.shell_tool':False,'features.code_mode':False,'features.skills':False,
        'features.multi_agent':False,'features.multi_agent_v2':False,'agents.enabled':False,'features.goals':False,
        'tools.update_plan.enabled':False,'tools.experimental_request_user_input.enabled':False,
        'features.apps':False,'approval_policy':'never','sandbox_mode':'read-only'}
    command=['/usr/bin/sandbox-exec','-p',relay.sandbox_profile,str(binary),'exec','resume','--ignore-user-config',
        '--ignore-rules','--skip-git-repo-check','--json','-m',MODEL]
    for key,value in overrides.items(): command += ['-c',key+'='+json.dumps(value)]
    command += [sid,'-']
    result={'mock':True,'realProviderRequests':0,'sessionId':sid,'command':command,'binarySha256':binary_sha,'targetVersion':args.profile,'passed':False,
            'fixtureUsesFrozenPlanPayload':True,'originalNativeBaselineSha256':hashlib.sha256(baseline).hexdigest()}
    child=None; buffers=[bytearray(),bytearray()]; caught=[]; handlers={}
    def cancel(sig,_):caught.append(sig)
    try:
        for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):handlers[sig]=signal.signal(sig,cancel)
        child=subprocess.Popen(command,env=env,cwd=source/'workspace',stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE,start_new_session=True)
        result['ownedPid']=child.pid; child.stdin.write(PROMPT.encode());child.stdin.close()
        streams={child.stdout:buffers[0],child.stderr:buffers[1]};deadline=time.monotonic()+50
        while streams and time.monotonic()<deadline:
            if caught or relay.summary()['blocked']:break
            ready,_,_=select.select(list(streams),[],[],.1)
            for stream in ready:
                chunk=os.read(stream.fileno(),65536)
                if not chunk:del streams[stream];continue
                streams[stream].extend(chunk);assert len(streams[stream])<4*1024*1024
        result['naturalExitCode']=child.poll()
    finally:
        relay.close()
        if child:
            result.update(OWNED.cleanup(child))
            child.stdout.close();child.stderr.close()
        result['signals']=caught;result['relay']=relay.summary()
        for name,data in zip(('stdout','stderr'),buffers):(case/name).write_bytes(relay.redact(bytes(data)))
        source_unchanged();result['originalPublicTargetAndSourceUnchanged']=True
        if (case/'native-request.json').exists():
            request=json.loads((case/'native-request.json').read_text())
            result['declaredTools']=[{'type':t.get('type'),'name':t.get('name')} for t in request.get('tools',[])]
            result['bodyKeys']=sorted(request)
            result['nonSystemRoles']=[m.get('role') for m in request.get('input',[]) if m.get('role') not in ('system','developer')]
        result['passed']=not caught and result.get('ownedProcessGroupGone') and result['relay']['dispatchAttempts']==0 and (case/'native-request.json').exists()
        private_json(case/'result.json',result)
        for sig,handler in handlers.items():signal.signal(sig,handler)
    print(json.dumps({k:result.get(k) for k in ('passed','realProviderRequests','relay','declaredTools','nonSystemRoles')}))


if __name__=='__main__':main()
