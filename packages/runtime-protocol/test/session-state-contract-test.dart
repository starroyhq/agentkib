import 'dart:convert';
import 'dart:io';

import '../generated/remote_protocol.g.dart';

Map<String, Object?> fixture(String name) =>
    jsonDecode(
          File.fromUri(
            Platform.script.resolve('fixtures/$name.json'),
          ).readAsStringSync(),
        )
        as Map<String, Object?>;

void main() {
  final states = fixture('session-state');
  for (final sample in states.entries) {
    final fields = sample.value as Map<String, Object?>;
    final live = fields['live'] as Map<String, Object?>;
    final state = SessionState.tryParse(live['state']);
    if ((state != null) != (sample.key != 'legacy')) {
      throw StateError('${sample.key}: unexpected decoding result');
    }
    if (sample.key == 'managedWorker' &&
        (state!.controls.assign as SessionControlDisabled).detail !=
            'session-is-a-worker') {
      throw StateError('Worker assignment reason was lost');
    }
  }

  final worker = states['managedWorker'] as Map<String, Object?>;
  final live = worker['live'] as Map<String, Object?>;
  final state = live['state'] as Map<String, Object?>;
  final controls = state['controls'] as Map<String, Object?>;
  final invalid = fixture('session-state-invalid');
  for (final entry in invalid.entries) {
    final fields = entry.value as Map<String, Object?>;
    final controlChanges = fields['controls'] as Map<String, Object?>?;
    final value = {
      ...state,
      ...fields,
      'controls': {...controls, ...?controlChanges},
    };
    if (SessionState.tryParse(value) != null) {
      throw StateError('${entry.key}: accepted an invalid state');
    }
  }
  stdout.writeln(
    '${states.length + invalid.length} session-state cases passed',
  );
}
