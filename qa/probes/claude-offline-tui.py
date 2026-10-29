"""Bounded offline Claude TUI checks of existing synthetic public imports.

Usage: python3 claude-offline-tui.py CASE NEW_EVIDENCE_DIR
No imports, model prompts, credentials, login selections or onboarding flags are
created. Each case gets at most two native starts. Only observed local onboarding
pages can receive input. The supervisor stays outside the network sandbox so its
owned-process cleanup can inspect ps; every native child denies all OS networking.
"""
import argparse
import codecs
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import time

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('owned_native', HERE / 'native-offline-tui.py')
OWNED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OWNED)
CLI = Path('/Users/user/.local/share/claude/versions/2.1.285')
CLI_SHA = '51f09bd1e021d9fa8a1864c179799bd37cb39962a937935c5cf6823398e86db4'
ARCHIVE = Path('/Users/user/Documents/AgentKib-archives/2026-09-30/full-interop')
CASES = {'offline-claude-code-to-claude-code', 'codex-to-claude-public-v3',
         'offline-cursor-to-claude-code', 'offline-hermes-to-claude-code',
         'offline-opencode-to-claude-code', 'offline-open-claw-to-claude-code'}
HEIGHT, WIDTH, MAX_OUTPUT = 100, 240, 2 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def compact(text):
    return re.sub(r'\s+', '', text)


class Screen:
    """Small VT screen for the cursor/erase sequences emitted by the pinned CLI.

    Input decisions inspect the current cells, never accumulated ANSI frames.
    Unrecognized display-changing sequences fail closed; style/queries are inert.
    """
    def __init__(self):
        self.rows = [[' '] * WIDTH for _ in range(HEIGHT)]
        self.row = self.col = 0
        self.saved = (0, 0)
        self.top, self.bottom = 0, HEIGHT - 1
        self.main_screen = None
        self.synchronized = False
        self.pending = ''
        self.decoder = codecs.getincrementaldecoder('utf-8')('strict')

    def feed(self, data):
        self.pending += self.decoder.decode(data)
        text = self.pending
        i = 0
        while i < len(text):
            ch = text[i]
            if ch == '\x1b':
                if i + 1 == len(text):
                    break
                kind = text[i + 1]
                if kind == '[':
                    match = re.match(r'\x1b\[([0-?]*)([ -/]*)([@-~])', text[i:])
                    if not match:
                        break
                    self.csi(*match.groups())
                    i += len(match.group(0))
                    continue
                if kind in ']P_':
                    end = re.search(r'\x07|\x1b\\', text[i + 2:])
                    if not end:
                        break
                    i += 2 + end.end()
                    continue
                if kind == '7':
                    self.saved = (self.row, self.col)
                elif kind == '8':
                    self.row, self.col = self.saved
                elif kind == 'c':
                    self.rows = [[' '] * WIDTH for _ in range(HEIGHT)]
                    self.row = self.col = 0
                else:
                    raise ValueError('Unsupported terminal ESC: ' + repr(kind))
                i += 2
                continue
            if ch == '\r':
                self.col = 0
            elif ch == '\n':
                if self.row == self.bottom:
                    self.rows.pop(self.top)
                    self.rows.insert(self.bottom, [' '] * WIDTH)
                else:
                    self.row = min(HEIGHT - 1, self.row + 1)
            elif ch == '\b':
                self.col = max(0, self.col - 1)
            elif ch == '\t':
                self.col = min(WIDTH - 1, (self.col // 8 + 1) * 8)
            elif ord(ch) >= 32 and ch != '\x7f':
                if self.col >= WIDTH:
                    self.col = 0
                    self.row = min(HEIGHT - 1, self.row + 1)
                self.rows[self.row][self.col] = ch
                self.col += 1
            i += 1
        self.pending = text[i:]

    def csi(self, params, intermediate, final):
        private = params[:1] in ('?', '>', '<', '=')
        nums = [int(x or '0') for x in params.lstrip('?><=').split(';')]
        n = nums[0] or 1
        if private:
            if params == '?1049' and final in 'hl' and not intermediate:
                if final == 'h' and self.main_screen is None:
                    self.main_screen = (self.rows, self.row, self.col, self.saved, self.top, self.bottom)
                    self.rows = [[' '] * WIDTH for _ in range(HEIGHT)]
                    self.row = self.col = 0
                    self.saved = (0, 0)
                    self.top, self.bottom = 0, HEIGHT - 1
                elif final == 'l' and self.main_screen is not None:
                    self.rows, self.row, self.col, self.saved, self.top, self.bottom = self.main_screen
                    self.main_screen = None
                return
            if params == '?2026' and final in 'hl' and not intermediate:
                self.synchronized = final == 'h'
                return
            if not intermediate and (params, final) in {
                    ('?', 'u'), ('<', 'u'), ('>', 'u'), ('>1', 'u'),
                    ('>0', 'q'), ('>4', 'm'), ('>4;0', 'm'), ('>4;1', 'm'), ('>4;2', 'm')}:
                return  # Exact keyboard/query negotiations; no display content.
            if not intermediate and params in {
                    '?25', '?1000', '?1002', '?1003', '?1004', '?1006', '?2004', '?2031'} and final in 'hl':
                return  # Cursor visibility, mouse/focus, paste, theme notification.
            raise ValueError('Unsupported private terminal sequence: ' + params + intermediate + final)
        if final in 'mnctq' or final == 'p' and intermediate:
            return  # Styles and queries do not change cells or cursor position.
        if private or intermediate:
            raise ValueError('Unsupported private display sequence')
        if final in 'Hf':
            self.row = max(0, min(HEIGHT - 1, n - 1))
            self.col = max(0, min(WIDTH - 1, (nums[1] or 1) - 1 if len(nums) > 1 else 0))
        elif final in 'ABCDEFGd':
            if final in 'ABEF':
                self.row = max(0, min(HEIGHT - 1, self.row + (n if final in 'BE' else -n)))
            if final in 'CD':
                self.col = max(0, min(WIDTH - 1, self.col + (n if final == 'C' else -n)))
            if final in 'EF':
                self.col = 0
            if final == 'G':
                self.col = max(0, min(WIDTH - 1, n - 1))
            if final == 'd':
                self.row = max(0, min(HEIGHT - 1, n - 1))
        elif final == 'J':
            mode = nums[0]
            if mode in (2, 3):
                self.rows = [[' '] * WIDTH for _ in range(HEIGHT)]
            elif mode == 0:
                self.rows[self.row][self.col:] = [' '] * (WIDTH - self.col)
                for row in range(self.row + 1, HEIGHT):
                    self.rows[row] = [' '] * WIDTH
            elif mode == 1:
                for row in range(self.row):
                    self.rows[row] = [' '] * WIDTH
                self.rows[self.row][:self.col + 1] = [' '] * (self.col + 1)
            else:
                raise ValueError('Unsupported erase display')
        elif final == 'K':
            start, end = (self.col, WIDTH) if nums[0] == 0 else ((0, self.col + 1) if nums[0] == 1 else (0, WIDTH))
            self.rows[self.row][start:end] = [' '] * (end - start)
        elif final == 's':
            self.saved = (self.row, self.col)
        elif final == 'u':
            self.row, self.col = self.saved
        elif final == 'r':
            self.top = n - 1
            self.bottom = (nums[1] or HEIGHT) - 1 if len(nums) > 1 else HEIGHT - 1
            assert 0 <= self.top < self.bottom < HEIGHT
            self.row = self.col = 0
        elif final == 'S':
            self.rows = (self.rows[n:] + [[' '] * WIDTH for _ in range(n)])[-HEIGHT:]
        else:
            raise ValueError('Unsupported terminal CSI: ' + final)

    def text(self):
        return '\n'.join(''.join(row).rstrip() for row in self.rows)

    def complete(self):
        return not self.pending and not self.decoder.getstate()[0] and not self.synchronized


def suffix_records(content, prefix, sid):
    assert content.startswith(prefix), 'Existing transcript prefix changed'
    suffix = content[len(prefix):]
    assert not suffix or suffix.endswith(b'\n'), 'Incomplete appended record'
    rows = [json.loads(line) for line in suffix.decode().splitlines()]
    assert all(row == {'type': 'atis-latch', 'atis': '', 'sessionId': sid} for row in rows), 'Unexpected new transcript records'
    return rows


def display_matches(text, messages):
    screen = compact(text)
    offset, matches = 0, []
    for role, body in messages:
        needle = ('❯' if role == 'user' else '⏺') + compact(body)
        index = screen.find(needle, offset)
        if index < 0:
            return []
        matches.append({'role': role, 'text': body, 'screenOffset': index})
        offset = index + len(needle)
    return matches


def local_action(text, workspace, done):
    value = compact(text).lower()
    if 'theme' not in done and all(s in value for s in ('choosethetextstylethatlooksbestwithyourterminal', '2.darkmode', 'syntaxtheme:')):
        return 'theme', b'\r'
    if 'security' not in done and all(s in value for s in ('securitynotes:', 'claudecanmakemistakes', 'pressentertocontinue')):
        return 'security', b'\r'
    if compact(str(workspace)).lower() in value and 'entertoconfirm' in value and 'yes,itrustthisfolder' in value:
        if 'trust-select' not in done and '❯no,exit' in value:
            return 'trust-select', b'\x1b[B'
        if 'trust-confirm' not in done and '❯yes,itrustthisfolder' in value and '❯no,exit' not in value:
            return 'trust-confirm', b'\r'
    return None


def run_tui(command, env, workspace, messages, evidence, number):
    record = {'run': number, 'command': command, 'inputs': [], 'networkDeniedByOSSandbox': True,
              'modelPromptsSent': 0, 'loginSelectionsSent': 0, 'passed': False}
    raw = bytearray()
    screen = Screen()
    child = master = slave = None
    cancellation = []
    handlers = {}
    done = set()
    def cancel(signum, _frame):
        cancellation.append(signum)  # Cleanup remains bounded after repeated signals.
    try:
        for sig in OWNED.SIGNALS:
            handlers[sig] = signal.signal(sig, cancel)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', HEIGHT, WIDTH, 0, 0))
        child = subprocess.Popen(command, env=env, cwd=workspace, stdin=slave, stdout=slave,
                                 stderr=slave, start_new_session=True)
        record['pid'] = child.pid
        os.close(slave)
        slave = None
        deadline = time.monotonic() + 40
        last_output = last_key = time.monotonic()
        while time.monotonic() < deadline:
            if cancellation:
                record['stopReason'] = 'cancelled'
                break
            if select.select([master], [], [], .1)[0]:
                try:
                    chunk = os.read(master, min(65536, MAX_OUTPUT - len(raw)))
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    chunk = b''
                if not chunk:
                    record['stopReason'] = 'pty-eof'
                    break
                raw.extend(chunk)
                screen.feed(chunk)
                last_output = time.monotonic()
                if len(raw) >= MAX_OUTPUT:
                    record['stopReason'] = 'output-limit'
                    break
                continue
            if child.poll() is not None:
                record['stopReason'] = 'native-exited'
                break
            # Render and input-handler commits must settle before the next key.
            if time.monotonic() - last_output < .4 or time.monotonic() - last_key < .6:
                continue
            if not screen.complete():
                continue  # Never act on a partial escape, UTF-8 glyph, or frame.
            current = screen.text()
            visible = display_matches(current, messages)
            if visible:
                record.update(passed=True, stopReason='complete-history-visible', displayedMessages=visible)
                break
            value = compact(current).lower()
            login = [s for s in ('selectloginmethod', 'selectaloginmethod', 'claudeaccountwithsubscription',
                     'anthropicconsoleaccount', 'howwouldyouliketologin', 'notloggedin',
                     'authenticationrequired', 'enteranapikey', 'enter your api key'.replace(' ', '')) if s in value]
            if login:
                record.update(stopReason='authentication-ui-no-selection', authenticationIndicators=login)
                break
            action = local_action(current, workspace, done)
            if action:
                page, key = action
                frame = f'run-{number}-before-{page}.txt'
                (evidence / frame).write_text(current)
                os.write(master, key)
                record['inputs'].append({'page': page, 'bytesHex': key.hex(), 'frame': frame, 'rawOffset': len(raw)})
                done.add(page)
                last_key = time.monotonic()
        else:
            record['stopReason'] = 'timeout-unverified-ui'
    except BaseException as exc:
        record['error'] = f'{type(exc).__name__}: {exc}'
    finally:
        try:
            if child is not None:
                record.update(OWNED.cleanup(child))
        except BaseException as exc:
            record.update(passed=False, cleanupError=f'{type(exc).__name__}: {exc}')
        finally:
            for fd in (master, slave):
                if fd is not None:
                    os.close(fd)
            record['signals'] = cancellation
            if cancellation:
                record.update(passed=False, stopReason='cancelled')
            record['rawBytes'] = len(raw)
            record['incompleteUtf8TailBytes'] = len(screen.decoder.getstate()[0])
            (evidence / f'run-{number}.ansi').write_bytes(raw)
            (evidence / f'run-{number}-screen.txt').write_text(screen.text())
            save(evidence / f'run-{number}.json', record)
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('case', type=Path)
    parser.add_argument('evidence', type=Path)
    args = parser.parse_args()
    case, evidence = args.case.resolve(), args.evidence.resolve()
    assert case.parent == ARCHIVE and case.name in CASES, 'Only existing approved synthetic cases'
    os.umask(0o077)
    evidence.mkdir(parents=True, exist_ok=False)
    (evidence / 'runner-source.py').write_bytes(Path(__file__).read_bytes())
    (evidence / 'cleanup-helper-source.py').write_bytes((HERE / 'native-offline-tui.py').read_bytes())
    summary = {'case': str(case), 'runs': [], 'passed': False, 'modelPromptsSent': 0}
    baseline = target = None
    try:
        result = json.loads((case / 'result.json').read_text())
        plan_path = case / ('plan.json' if case.name == 'codex-to-claude-public-v3' else 'file-plan.json')
        plan = json.loads(plan_path.read_text())
        launch = plan['launch_request']
        assert launch['target_agent'] == result['target'] == 'claude-code'
        target = Path(launch['target_path']).resolve()
        assert target.is_relative_to(case / 'claude/projects')
        sid = launch['target_session_id']
        assert target.name == sid + '.jsonl'
        payload, = [row['after'].encode() for row in plan['change_set']['changes'] if row['target'] == str(target)]
        rows = [json.loads(line) for line in payload.decode().splitlines()]
        assert all(row['sessionId'] == sid for row in rows)
        messages = []
        for row in rows:
            if row['type'] in ('user', 'assistant'):
                assert row['message']['role'] == row['type']
                assert all(part['type'] == 'text' for part in row['message']['content'])
                messages.append((row['type'], '\n'.join(part['text'] for part in row['message']['content'])))
        assert len(messages) == 3 and messages[0][0] == 'user'
        assert messages[1:] == [('user', f'Remember marker {result["marker"]}; project decision: {result["decision"]}.'),
                                ('assistant', f'Confirmed {result["marker"]} and {result["decision"]}.')]
        sources = result.get('sourceFiles') or {result['source']: result['sourceSha256'],
                    **{row['path']: row['sha256'] for row in result['sourceMetadata']}}
        for path in sources:
            assert Path(path).resolve().is_relative_to(case)
        expected_files = {str(target)}
        if result['sourceAgent'] == 'claude-code':
            expected_files.add(str(Path(result['source']).resolve()))
        baseline = target.read_bytes()
        assert baseline.startswith(payload), 'Production payload changed'
        if case.name == 'codex-to-claude-public-v3':
            old = json.loads((case / 'claude-once-result.json').read_text())
            assert old['mode'] == 'live' and old['nativeSessionId'] == sid
            assert old['cliExitCode'] == 1 and old['nativeSuccess'] is False and old['acceptancePassed'] is False
            assert old['sourceUnchanged'] and old['originalHistoryPrefixPreserved'] and old['sessionFileCount'] == 1
            existing_rows = [json.loads(line) for line in baseline[len(payload):].decode().splitlines()]
            assert all(row.get('sessionId', sid) == sid for row in existing_rows)
            summary['preservedPriorLiveFailure'] = {'receipt': str(case / 'claude-once-result.json'),
                'receiptSha256': digest((case / 'claude-once-result.json').read_bytes()),
                'baselineSuffixTypes': [row['type'] for row in existing_rows],
                'priorFailureIsNotRetried': True, 'importedMessagesAndPriorFailureAreSeparate': True}
        else:
            suffix_records(baseline, payload, sid)
        def verify():
            current = target.read_bytes()
            appended = suffix_records(current, baseline, sid)
            hashes = {path: digest(Path(path).read_bytes()) for path in sources}
            assert hashes == sources, 'Original source or metadata changed'
            files = {str(path.resolve()) for path in (case / 'claude/projects').rglob('*.jsonl')}
            assert files == expected_files, 'Session file set changed'
            return {'sourceHashes': hashes, 'targetSha256': digest(current), 'productionPayloadSha256': digest(payload),
                'baselineSha256': digest(baseline), 'productionPrefixUnchanged': current.startswith(payload),
                'completeBaselinePrefixUnchanged': True, 'newRecords': appended, 'noNewUserOrAssistant': True,
                'sessionId': sid, 'nativeFiles': sorted(files), 'importedSessionCount': 1}
        assert digest(CLI.read_bytes()) == CLI_SHA
        env = {'HOME': str(case / 'home'), 'CLAUDE_CONFIG_DIR': str(case / 'claude'),
               'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8', 'TERM': 'xterm-256color',
               'DISABLE_AUTOUPDATER': '1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
        command = OWNED.SANDBOX + [str(CLI), '--bare', '--safe-mode', '--setting-sources', '',
            '--settings', '{}', '--strict-mcp-config', '--tools', '', '--no-chrome', '--resume', sid]
        summary.update(sessionId=sid, productionPayloadBytes=len(payload), baselineBytes=len(baseline),
                       probeSha256=digest(Path(__file__).read_bytes()), cleanupHelperSha256=digest((HERE / 'native-offline-tui.py').read_bytes()),
                       binarySha256=CLI_SHA, environment=env, before=verify())
        save(evidence / 'preflight.json', summary)
        for number in (1, 2):
            run = run_tui(command, env, case / 'workspace', messages, evidence, number)
            summary['runs'].append(run)
            run['after'] = verify()
            save(evidence / f'run-{number}-integrity.json', run['after'])
            assert run.get('ownedProcessGroupGone'), 'Owned process group remained'
            assert run['passed'], 'Native history not verified: ' + run.get('stopReason', run.get('error', 'unknown'))
        summary['after'] = verify()
        summary['passed'] = True
    except BaseException as exc:
        summary['error'] = f'{type(exc).__name__}: {exc}'
    finally:
        if baseline is not None and target is not None:
            summary['finalTargetSha256'] = digest(target.read_bytes())
            summary['completeBaselinePrefixPreservedAtExit'] = target.read_bytes().startswith(baseline)
        save(evidence / 'result.json', summary)
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0 if summary['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
