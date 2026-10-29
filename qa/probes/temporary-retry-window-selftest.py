"""Isolated tests for retry-window restoration. Never accesses actual user config."""
import importlib.util
import json
import signal
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import yaml

spec = importlib.util.spec_from_file_location('window', Path(__file__).with_name('temporary-retry-window.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

ORIGINAL = '''# preserved
routing:
  retry:
    request-retry: 3 # rounds
    max-retry-credentials: 0
requests:
  passthrough-headers: false
'''


class WindowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        w.CPA, w.CC, w.AUTH = (self.root / name for name in ('config.yaml', 'cc.db', 'auths'))
        w.AUTH.mkdir()
        (w.AUTH / 'synthetic.json').write_text('{"type":"relay","disabled":false}')
        w.CPA.write_text(ORIGINAL)
        with sqlite3.connect(w.CC) as db:
            db.execute('create table settings(key text primary key,value text)')
            db.execute('create table proxy_config(app_type text,auto_failover_enabled int)')
            db.execute("insert into proxy_config values('claude',0)")
        self.reload = patch.object(w, 'verify_reload', return_value=['synthetic acknowledgment'])
        self.reload_mock = self.reload.start()

    def tearDown(self):
        self.reload.stop()
        self.temp.cleanup()

    def run_case(self, name, code):
        w.run(self.root / name, [sys.executable, '-c', code])

    def assert_restored(self):
        self.assertEqual(w.CPA.read_text(), ORIGINAL)
        self.assertIsNone(w.cc_read())

    def test_success_and_child_failure_restore(self):
        self.run_case('success', 'pass')
        self.assert_restored()
        with self.assertRaises(RuntimeError):
            self.run_case('failure', 'raise SystemExit(2)')
        self.assert_restored()

    def test_unrelated_concurrent_edits_survive(self):
        child = '''from pathlib import Path
import sqlite3,json
p=Path(%r)
p.write_text(p.read_text().replace('passthrough-headers: false','passthrough-headers: true'))
db=sqlite3.connect(%r)
v=json.loads(db.execute("select value from settings where key='rectifier_config'").fetchone()[0])
v['requestThinkingBudget']=False
db.execute("update settings set value=? where key='rectifier_config'",(json.dumps(v),))
db.commit()
''' % (str(w.CPA), str(w.CC))
        self.run_case('sibling', child)
        self.assertEqual(w.CPA.read_text(), ORIGINAL.replace('passthrough-headers: false', 'passthrough-headers: true'))
        self.assertEqual(json.loads(w.cc_read()), {'requestThinkingBudget': False})

    def test_same_field_conflict_restores_other_fields(self):
        child = 'from pathlib import Path;p=Path(%r);p.write_text(p.read_text().replace("request-retry: 0","request-retry: 7"))' % str(w.CPA)
        with self.assertRaisesRegex(RuntimeError, 'changed externally'):
            self.run_case('conflict', child)
        self.assertEqual(yaml.safe_load(w.CPA.read_text())['routing']['retry'], {'request-retry': 7, 'max-retry-credentials': 0})
        self.assertNotIn('streaming', yaml.safe_load(w.CPA.read_text())['requests'])
        self.assertIsNone(w.cc_read())
        self.assertEqual(json.loads((self.root / 'conflict/journal.json').read_text())['status'], 'restore-needs-attention')

    def test_restore_confirmation_timeout_cannot_be_cleared_by_original_disk(self):
        self.reload_mock.side_effect = [['open reload'], RuntimeError('reload timeout')]
        with self.assertRaisesRegex(RuntimeError, 'reload timeout'):
            self.run_case('timeout', 'pass')
        self.assert_restored()
        case = self.root / 'timeout'
        proof = json.loads((case / 'journal.json').read_text())['restoreConfirmation']
        self.reload_mock.side_effect = RuntimeError('still no reload')
        with self.assertRaisesRegex(RuntimeError, 'still no reload'):
            w.restore(case)
        self.assertTrue(json.loads((case / 'journal.json').read_text())['cpaAttempted'])
        self.assertEqual(self.reload_mock.call_args.args[0], proof['since'])
        self.reload_mock.side_effect = None
        w.restore(case)
        self.assertEqual(json.loads((case / 'journal.json').read_text())['status'], 'restored')

    def test_restore_ignores_repeated_graceful_signal_and_restores_handlers(self):
        handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
        original_restore = w.restore
        def signal_during_restore(directory):
            for sig in handlers:
                self.assertEqual(signal.getsignal(sig), signal.SIG_IGN)
                os.kill(os.getpid(), sig)
            return original_restore(directory)
        with patch.object(w, 'restore', side_effect=signal_during_restore):
            self.run_case('repeated-signal', 'pass')
        self.assert_restored()
        self.assertEqual({sig: signal.getsignal(sig) for sig in handlers}, handlers)

    def test_process_lookup_cleanup_does_not_skip_restore(self):
        fake = unittest.mock.Mock()
        fake.wait.side_effect = subprocess.TimeoutExpired('synthetic', 1)
        fake.poll.return_value = None
        with patch.object(w.subprocess, 'Popen', return_value=fake), patch.object(w.os, 'killpg', side_effect=ProcessLookupError):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.run_case('cleanup-race', 'pass')
        self.assert_restored()


if __name__ == '__main__':
    unittest.main()
