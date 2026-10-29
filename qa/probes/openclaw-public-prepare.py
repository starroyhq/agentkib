"""Fresh public Grok import with a pinned, network-denied Node launch wrapper."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = Path('/Users/user/Documents/AgentKib-archives/2026-10-01/provider-retest/OpenClaw/completion-v2')
TOOLS = Path('/Users/user/Documents/AgentKib-archives/2026-09-30/native-interop/tools')
NODE = Path('/opt/homebrew/Cellar/node/26.9.0/bin/node')
spec = importlib.util.spec_from_file_location('owned', HERE / 'native-offline-tui.py')
owned = importlib.util.module_from_spec(spec); spec.loader.exec_module(owned)
from deepseek_once_relay import private_json, digest


def wrapped(args):
    evidence = ROOT / 'public-prepare'
    env = {k:v for k,v in os.environ.items() if k in owned.PATH_KEYS | owned.FLAG_KEYS | {'PATH','LANG','TERM'}}
    for k in owned.PATH_KEYS & set(env):
        assert Path(env[k]).resolve().is_relative_to(ROOT / 'public-case')
    cmd = owned.SANDBOX + [str(NODE)] + args
    if 'tui' not in args:
        os.execve(cmd[0], cmd, env)
    # Public Terminal launches can arrive after the RPC caller returns. The lock
    # closes this preparation window without touching any other Terminal session.
    child = None
    with (evidence / 'launch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (evidence / 'launch-closed.json').exists(): return
        child = subprocess.Popen(cmd, env=env, start_new_session=True)
        private_json(evidence / ('launch-%s.json' % child.pid), {'pid':child.pid,'command':cmd})
    try:
        child.wait(timeout=4)
    except subprocess.TimeoutExpired:
        pass
    finally:
        private_json(evidence / ('cleanup-%s.json' % child.pid), owned.cleanup(child))


def main():
    if sys.argv[1:2] == ['node']:
        return wrapped(sys.argv[2:])
    os.umask(0o077)
    evidence = ROOT / 'public-prepare'; evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    tools = evidence / 'tools'; (tools / 'bin').mkdir(parents=True)
    (tools / 'openclaw').symlink_to(TOOLS / 'openclaw')
    wrapper = tools / 'bin/node'
    wrapper.write_text('#!/bin/sh\nexec ' + ' '.join(shlex.quote(x) for x in
        [sys.executable, str(Path(__file__).resolve()), 'node']) + ' "$@"\n')
    wrapper.chmod(0o700)
    cmd = [sys.executable,str(HERE/'main-interop-rpc.py'),str(HERE.parent.parent/'target/debug/agentkib-runtime'),
           str(tools),str(ROOT/'public-case'),'openclaw','grok-build']
    try:
        with (evidence/'public-import.log').open('wb') as out:
            proc = subprocess.run(cmd,stdout=out,stderr=subprocess.STDOUT,timeout=180)
        assert proc.returncode == 0, 'Public import failed; preserve evidence'
    finally:
        with (evidence/'launch.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX);private_json(evidence/'launch-closed.json',{'closed':True})
        groups = []
        for path in evidence.glob('launch-*.json'):
            if path.name == 'launch-closed.json':continue
            pid=json.loads(path.read_text())['pid']
            for sig in (signal.SIGTERM,signal.SIGKILL):
                if owned.group_exists(pid): os.killpg(pid,sig)
            groups.append(pid)
        # Wrapper supervisors also reap their owned leaders before returning.
        import time
        deadline=time.monotonic()+5
        while any(owned.group_exists(p) for p in groups) and time.monotonic()<deadline: time.sleep(.05)
        assert not any(owned.group_exists(p) for p in groups)
        private_json(evidence/'preparation-cleanup.json',{'pgids':groups,'allGone':True,'modelRequests':0})
    private_json(evidence/'prepared.json',{'command':cmd,'nodeSha256':digest(NODE.read_bytes()),
        'wrapperSha256':digest(wrapper.read_bytes()),'runnerSha256':digest(Path(__file__).read_bytes()),'modelRequests':0})


if __name__ == '__main__': main()
