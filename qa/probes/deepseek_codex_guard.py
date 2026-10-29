"""Pinned Codex Responses projection and fail-closed buffered reply guard.

The shared relay's default tools=none contract stays unchanged. Its only new
envelope policy pins one definition. This subclass validates the full projection
and buffers the response; no request/response bytes are rewritten.
"""
import copy
import json
import re
import time
from pathlib import Path

from deepseek_once_relay import MODEL, OnceRelay, digest, private_json

REFERENCE = Path('/Users/user/Documents/AgentKib-archives/2026-10-01/provider-retest/Codex/native-mock-03/native-request.json')
REFERENCE_SHA = '5474b2284c026a2d06d022a3a15626b1d68fc9b2aaee6cb93be1f50f022d2fb4'
TOOLS_SHA = 'c02c1f46148c20f253d78c3ef8ce36621125b5270545e5fde673dd253da50e7a'
POLICY = 'codex-fixed-functions'
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
REFERENCE_155 = Path('/Users/user/Documents/AgentKib-archives/2026-10-01/codex-completion-batch/compat-155-native-capture/native-request.json')
REFERENCE_155_SHA = 'c2a932fc39ee6996010862af76c39d4559afeb36c70d2aaa59c60f7f666a97fd'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            assert key not in result, 'Duplicate JSON key'
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(AssertionError('Nonfinite JSON')))


def normalize_message(message):
    assert isinstance(message, dict) and set(message) <= {'type', 'id', 'role', 'content'}
    assert message.get('type') == 'message'
    if 'id' in message:
        assert re.fullmatch('msg_' + UUID, message['id'])
    assert message['role'] in ('user', 'assistant', 'developer')
    assert isinstance(message['content'], list) and message['content']
    for part in message['content']:
        assert set(part) == {'type', 'text'} and isinstance(part['text'], str)
        assert part['type'] == ('output_text' if message['role'] == 'assistant' else 'input_text')
    return {k: v for k, v in message.items() if k != 'id'}


def make_projection(history, prompt, workspace, codex_home, date, version='0.146.1'):
    assert version in ('0.146.1', '0.155.1')
    reference_path = REFERENCE if version == '0.146.1' else REFERENCE_155
    reference_sha = REFERENCE_SHA if version == '0.146.1' else REFERENCE_155_SHA
    raw = reference_path.read_bytes()
    assert digest(raw) == reference_sha, 'Reviewed native projection reference changed'
    reference = strict_json(raw)
    assert digest(canonical(reference['tools'])) == TOOLS_SHA
    assert len(history) == 3 and [m['role'] for m in history] == ['user', 'user', 'assistant']
    old_workspace = '/Users/user/Documents/AgentKib-archives/2026-09-30/full-interop/claude-to-codex-public-fixed-v2/workspace'
    old_home = str(reference_path.parent / 'codex')
    extras = [normalize_message(m) for m in reference['input'][3:-1]]
    assert [m['role'] for m in extras] == ['developer', 'user']
    assert re.fullmatch(r'\d{4}-\d{2}-\d{2}', date)
    for message in extras:
        for part in message['content']:
            part['text'] = part['text'].replace(old_workspace, str(workspace)).replace(old_home, str(codex_home))
            part['text'] = part['text'].replace('<current_date>2026-10-01</current_date>', '<current_date>' + date + '</current_date>')
    def msg(row):
        return {'type': 'message', 'role': row['role'], 'content': [
            {'type': 'output_text' if row['role'] == 'assistant' else 'input_text', 'text': row['text']}]}
    return {'expectedInput': [msg(m) for m in history] + extras + [msg({'role': 'user', 'text': prompt})],
            'instructions': reference['instructions'], 'tools': reference['tools'],
            'referenceSha256': reference_sha, 'toolsSha256': TOOLS_SHA}


def validate_request(body, contract):
    version = contract.get('codexVersion', '0.146.1')
    assert version in ('0.146.1', '0.155.1')
    assert set(body) == {'model', 'instructions', 'input', 'tools', 'tool_choice', 'parallel_tool_calls',
                         'reasoning', 'store', 'stream', 'include', 'prompt_cache_key', 'client_metadata'}
    assert body['model'] == MODEL and body['stream'] is True and body['store'] is False
    assert body['tool_choice'] == 'auto' and body['parallel_tool_calls'] is (version == '0.155.1')
    assert body['reasoning'] == {'summary': 'auto'} and body['include'] == ['reasoning.encrypted_content']
    assert body['instructions'] == contract['projection']['instructions']
    assert digest(canonical(body['tools'])) == TOOLS_SHA
    assert body['tools'] == contract['projection']['tools']
    assert [normalize_message(m) for m in body['input']] == contract['projection']['expectedInput'], 'Exact history/environment/prompt mismatch'
    sid = contract['sessionId']
    assert body['prompt_cache_key'] == sid
    meta = body['client_metadata']
    meta_keys = {'x-codex-turn-metadata', 'x-codex-installation-id', 'thread_id',
                 'x-codex-window-id', 'turn_id', 'session_id'}
    if version == '0.155.1': meta_keys.add('root_turn_id')
    assert set(meta) == meta_keys
    assert meta['thread_id'] == meta['session_id'] == sid
    assert meta['x-codex-window-id'] == sid + ':0'
    assert re.fullmatch(UUID, meta['turn_id']) and re.fullmatch(UUID, meta['x-codex-installation-id'])
    turn = strict_json(meta['x-codex-turn-metadata'])
    expected_turn = {'installation_id': meta['x-codex-installation-id'], 'session_id': sid,
                    'thread_id': sid, 'turn_id': meta['turn_id'], 'window_id': sid + ':0',
                    'request_kind': 'turn', 'thread_source': 'exec', 'sandbox': 'seatbelt',
                    'turn_started_at_unix_ms': turn['turn_started_at_unix_ms']}
    if version == '0.155.1':
        assert meta['root_turn_id'] == meta['turn_id']
        assert re.fullmatch(UUID, turn['context_window_id'])
        assert type(turn['window_number']) is int and turn['window_number'] == 0
        assert all(turn[key] is False for key in ('auto_review_enabled', 'node_repl_auto_review_required', 'node_repl_disabled'))
        expected_turn.update(agent_name='/root', root_turn_id=meta['turn_id'], window_number=0,
            context_window_id=turn['context_window_id'], sandbox_mode='read-only',
            auto_review_enabled=False, node_repl_auto_review_required=False, node_repl_disabled=False)
    assert set(turn) == set(expected_turn) and turn == expected_turn
    assert type(turn['turn_started_at_unix_ms']) is int
    assert contract['startedAt'] - 10 <= turn['turn_started_at_unix_ms'] / 1000 <= time.time() + 2
    return {'historyValidated': True, 'sessionId': sid, 'toolsSha256': TOOLS_SHA,
            'projectionSha256': digest(canonical(contract['projection'])), 'wireBodyRewritten': False,
            'declaredToolExecutionPermitted': False}


def validate_sse(raw):
    """Accept only a complete, internally consistent text/reasoning response.

All frames are examined before a single response byte reaches Codex. Checking
only the final response would allow an earlier function_call delta to execute.
"""
    text = raw.decode('utf-8', errors='strict').replace('\r\n', '\n')
    assert '\r' not in text and text.endswith('\n\n'), 'Incomplete SSE frame'
    allowed = {'response.created', 'response.in_progress', 'response.output_item.added',
               'response.output_item.done', 'response.content_part.added', 'response.content_part.done',
               'response.output_text.delta', 'response.output_text.done', 'response.reasoning_text.delta',
               'response.reasoning_text.done', 'response.reasoning_summary_text.delta',
               'response.reasoning_summary_text.done', 'response.reasoning_summary_part.added',
               'response.reasoning_summary_part.done', 'response.completed'}
    safe_types = allowed | {'response', 'message', 'output_text', 'reasoning', 'reasoning_text', 'summary_text'}
    def scan(value):
        if isinstance(value, dict):
            if 'type' in value:
                assert value['type'] in safe_types, 'Unknown or callable response item'
            assert not value.get('error') and not value.get('incomplete_details')
            for key in ('tool_calls', 'function_call', 'tool_call', 'arguments', 'refusal'):
                assert key not in value, 'Callable/refusal response field'
            if 'status' in value:
                assert value['status'] in ('in_progress', 'completed')
            for child in value.values(): scan(child)
        elif isinstance(value, list):
            for child in value: scan(child)
    events, terminal, done_sentinel = [], None, False
    deltas, dones, item_dones = {}, {}, {}
    response_id = None
    for frame in text.split('\n\n'):
        if not frame: continue
        assert not done_sentinel, 'Data after DONE'
        data, name = [], None
        for line in frame.split('\n'):
            if line.startswith(':'): continue
            if line.startswith('data:'): data.append(line[5:].lstrip(' '))
            elif line.startswith('event:'):
                assert name is None
                name = line[6:].strip()
            else: raise AssertionError('Unknown SSE field')
        if not data: continue
        payload = '\n'.join(data)
        if payload == '[DONE]':
            assert terminal is not None
            done_sentinel = True
            continue
        assert terminal is None, 'Events after completed response'
        event = strict_json(payload)
        kind = event['type']
        assert kind in allowed and (name is None or name == kind)
        # Responses echoes the request's declarative schemas. Their `type`
        # fields are not output items. Validate these two exact metadata paths
        # before scanning a copy; the original frame and forwarded bytes stay
        # untouched, and every output/item/delta still uses the strict scan.
        scanning = copy.deepcopy(event)
        if 'response' in scanning:
            assert kind in ('response.created', 'response.in_progress', 'response.completed')
            metadata = scanning['response']
            if 'tools' in metadata:
                assert digest(canonical(metadata.pop('tools'))) == TOOLS_SHA, 'Echoed tool definition changed'
            if 'text' in metadata:
                assert metadata.pop('text') == {'format': {'type': 'text'}, 'verbosity': None}, 'Echoed response text format changed'
        scan(scanning)
        events.append(kind)
        if 'response' in event:
            response = event['response']
            assert isinstance(response.get('id'), str) and response['id']
            assert response.get('model') == MODEL, 'Upstream response model changed'
            response_id = response_id or response['id']
            assert response['id'] == response_id
        if kind.startswith('response.output_text.'):
            key = (event['item_id'], event['output_index'], event['content_index'])
            assert type(key[1]) is int and type(key[2]) is int and min(key[1:]) >= 0
            if kind.endswith('.delta'):
                assert key not in dones and isinstance(event['delta'], str)
                deltas[key] = deltas.get(key, '') + event['delta']
            else:
                assert key not in dones and isinstance(event['text'], str)
                assert deltas.get(key, '') == event['text'], 'Text delta/final mismatch'
                dones[key] = event['text']
        if kind == 'response.output_item.done':
            index = event['output_index']
            assert type(index) is int and index >= 0 and index not in item_dones
            item_dones[index] = event['item']
        if kind == 'response.completed':
            terminal = event['response']
            assert terminal['status'] == 'completed' and isinstance(terminal['output'], list)
    assert terminal is not None and events[0] == 'response.created'
    output = terminal['output']
    assert output and set(item_dones) == set(range(len(output)))
    answer, expected_keys = [], set()
    for index, item in enumerate(output):
        assert item_dones[index] == item
        assert item['type'] in ('message', 'reasoning')
        if item['type'] == 'message':
            assert item['role'] == 'assistant' and item.get('status') == 'completed'
            assert isinstance(item['content'], list) and item['content']
            for part_index, part in enumerate(item['content']):
                assert part['type'] == 'output_text' and isinstance(part['text'], str)
                key = (item['id'], index, part_index)
                expected_keys.add(key)
                assert dones.get(key) == part['text']
                answer.append(part['text'])
    assert expected_keys == set(dones) == set(deltas) and len(answer) == 1 and answer[0]
    return {'passed': True, 'answer': answer[0], 'responseId': response_id,
            'events': events, 'responseSha256': digest(raw), 'toolCalls': 0, 'rawRewritten': False}


class CodexRelay(OnceRelay):
    def __init__(self, contract_path, snapshot, *, offline=False, _connection_factory=None):
        assert (offline and _connection_factory is not None) or (not offline and _connection_factory is None)
        super().__init__(contract_path, snapshot, offline=offline, validator=validate_request,
                         _connection_factory=_connection_factory)
        assert self.contract['tools'] == POLICY and self.contract['protocol'] == 'responses'
        assert re.fullmatch(UUID, self.contract['sessionId'])
        assert digest(canonical(self.contract['projection']['tools'])) == TOOLS_SHA

    def admit(self, route, headers, raw):
        # Reject duplicate keys before the shared admission can consume its token.
        strict_json(raw)
        return super().admit(route, headers, raw)

    def forward(self, raw, headers, query=''):
        status, content_type, response = super().forward(raw, headers, query)
        assert status == 200 and content_type.split(';')[0].strip() == 'text/event-stream'
        proof = validate_sse(response)
        private_json(self.path.parent / 'response-validation.json', proof)
        return status, content_type, response


def synthetic_sse(answer):
    item = {'type': 'message', 'id': 'msg_synthetic', 'role': 'assistant', 'status': 'completed',
            'content': [{'type': 'output_text', 'text': answer, 'annotations': []}]}
    response = {'id': 'resp_synthetic', 'object': 'response', 'status': 'completed', 'model': MODEL,
                'output': [item], 'usage': {'input_tokens': 20, 'output_tokens': 10, 'total_tokens': 30}}
    events = [{'type': 'response.created', 'response': dict(response, status='in_progress', output=[])},
        {'type': 'response.output_item.added', 'output_index': 0, 'item': dict(item, status='in_progress', content=[])},
        {'type': 'response.output_text.delta', 'item_id': item['id'], 'output_index': 0, 'content_index': 0, 'delta': answer},
        {'type': 'response.output_text.done', 'item_id': item['id'], 'output_index': 0, 'content_index': 0, 'text': answer},
        {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
        {'type': 'response.completed', 'response': response}]
    return ''.join('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n' for e in events).encode()


def synthetic_transport(raw, status=200):
    class Socket:
        def settimeout(self, _): pass
        def shutdown(self, _): pass
        def close(self): pass
    class Response:
        def __init__(self): self.status = status
        def read(self, _): return raw
        def getheader(self, *_): return 'text/event-stream'
    class Connection:
        def __init__(self, *_args, **_kwargs): self.sock = None
        def connect(self): self.sock = Socket()
        def request(self, method, path, body, headers):
            assert method == 'POST' and path == '/responses'
        def getresponse(self): return Response()
        def close(self): pass
    return Connection
